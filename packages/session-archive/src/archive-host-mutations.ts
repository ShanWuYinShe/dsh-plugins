/**
 * archive-host-mutations.ts — 写操作：deleteArchived / unarchive。
 *
 * 2026-10-08 从 archive-host.ts 拆出：方法体逐字保留，只把原先同作用域的助手改为
 * 从 deps 解构（见 archive-host-context.ts）。
 *
 * @module @chaoset/session-archive/archive-host-mutations
 */

import { stat, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BUSY_WRITE_WINDOW_MS, REAPPEAR_SETTLE_MS, removeSessionDirIfOwned } from './session-scan.js'
import type { HostContext } from './archive-host-context.js'

export function createArchiveMutations(deps: HostContext) {
  const {
    ctx,
    persistence,
    archivedSet,
    snapshotsByIds,
    settleStat,
    exclusive,
    removeFromArchiveSet,
    resolveGenerationFile,
    fileInfo,
    filePresentAfterSettle,
  } = deps

  return {
    /**
     * 批量彻底删除归档会话。live 会话拒绝（先停止再删）；每个会话删除
     * 持久化文件与会话目录。删除后**不**从归档集合移除 id（保留 ghost id）：
     * 归档不停止内存会话，一旦把 id 移出归档集合，侧边栏（以"不在归档
     * 集合中"作为显示条件）会立刻把仍在内存中的会话重新显示出来，等同
     * "恢复"。ghost id 由 list() 的存在性过滤隐藏，面板与侧边栏均不再
     * 显示该会话；`removedFromArchive` 因此恒为 0。
     *
     * 宿主原生的"设置 → 已归档会话"页按"归档集合 JOIN 会话摘要"展示，
     * ghost id 只要内存会话还在就会继续显示（内存消亡无官方 API，只能
     * 随宿主重启）。`needsRestart` 如实返回这类"文件已删、内存仍在"的
     * id，调用方据此提示用户并刷新客户端会话列表（cold 删除即时见效）。
     *
     * 失败语义（failed[].reason）：'not-archived' 非归档成员；'busy' 内存中
     * 的会话日志仍在增长（活跃生成流）；
     * 'unenumerable' 文件存在但持久化枚举不到（首行损坏的孤儿），或无法
     * 确认文件已消失的 ghost id；'reappeared' 删除后被生成流重建、二次
     * 删除仍压不掉；其余为底层删除错误消息。
     */
    async deleteArchived(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const deleted: string[] = [];
      const failed: Array<{ sessionId: string; reason: string }> = [];
      const needsRestart: string[] = [];
      /** 删除成功记账：文件已删、但内存会话仍在的 id 需要宿主重启才能
       * 从原生"设置 → 已归档会话"页消失，如实返回给调用方提示用户。 */
      const markDeleted = (sessionId: string): void => {
        deleted.push(sessionId);
        if (ctx.sessions.get(sessionId as SessionId) !== undefined) needsRestart.push(sessionId);
      };
      // 归档成员前置校验:persistence 覆盖所有持久化会话而非仅归档会话,
      // 不校验的话任何"未归档、不在内存"的会话 id 都会绕过 live/busy
      // 两道保护被不可逆物理删除。快照只 stat 归档成员:非成员在循环里
      // 前置拒绝,不必查持久层。
      const archived = archivedSet();
      const snapshots = await snapshotsByIds(unique.filter((id) => archived.has(id)));

      /** 常规删除流（located 路径），必须在 exclusive 临界区内调用：
       * TOCTOU 复核 → busy 沉降观察 → rm → 重现复验。 */
      const deleteLocatedFile = async (sessionId: string, path: string): Promise<void> => {
        try {
          // TOCTOU 复核:fileInfo 的 stat 是快照,检查与 rm 之间文件可能
          // 恰好变化;rm 前重取一次。只有 ENOENT 才是「已消失」,其余错误
          // 上抛以真实原因计入 failed。
          let fresh: { size: number; mtimeMs: number } | null = await stat(path).then(
            (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
            (error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; },
          );
          if (fresh === null) {
            // stat 落空 ≠ 会话数据已删:jsonl 后端的格式迁移是"写临时文件 +
            // rename",若迁移恰好落在锁外定位与本次复核之间,旧代际路径已
            // 被 rename 走,而新代际文件仍在同一目录——直接记账会出现"已删
            // 却仍在列表"。复扫目录:扫到实际代际文件就以它为新删除目标;
            // 确实无任何代际文件才认定删除完成(顺带补上目录清理)。
            const migrated = await resolveGenerationFile(dirname(path));
            if (migrated !== null) path = migrated;
            fresh = await stat(path).then(
              (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
              (error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; },
            );
            if (fresh === null) {
              // 复扫后仍落空(无新代际,或迁移竞态二连/并发他删):按幂等
              // 删除处理,列表的存在性过滤自会隐藏幽灵 id。
              await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
              markDeleted(sessionId);
              return;
            }
          }
          // 生成流兜底:内存中的会话且 mtime 在窗口内,沉降观察一次,文件
          // 仍在增长说明活跃写入方在 append(删除后会把半截日志写回来),
          // 拒绝;体积静止则只是一次性落盘/迁移/flush 刷新过 mtime,照删。
          const inMemory = ctx.sessions.get(sessionId as SessionId) !== undefined;
          if (inMemory && Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS) {
            const second = await settleStat(path);
            if (second === null) {
              markDeleted(sessionId);
              return;
            }
            if (second.size > fresh.size) {
              failed.push({ sessionId, reason: 'busy' });
              return;
            }
            fresh = second;
          }
          await rm(path, { force: true });
          await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
          // rm 后复验：防宿主 materialize 的 mkdir -p 把路径在删除窗口内重建。
          // 重现只可能来自活跃写入方（内存中的生成流，或刚写完不久、客户端
          // 重连即恢复的 tab）。据此分两档：
          //   - 可能活跃（内存存在 或 60s 内有写入）：维持原 300ms settle 两段
          //     复验；重现则再删一次，仍未删掉计入 failed('reappeared')。
          //   - 冷文件（不在内存且超过 60s 无写入）：未来写入需要用户主动继续
          //     对话，不会落在删除窗口内——做零等待的即时复验即可。批量清理
          //     陈旧归档不再为每个文件白付 2×300ms。
          const plausiblyActive = inMemory || Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS;
          const settleMs = plausiblyActive ? REAPPEAR_SETTLE_MS : 0;
          if (await filePresentAfterSettle(path, settleMs)) {
            try {
              await rm(path, { force: true });
              await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
            } catch (error) {
              // 二次删除失败必须以真实原因上报:吞掉会让 EPERM/EBUSY 被
              // 误标为 reappeared,把排障方向带偏。
              ctx.logger?.warn?.(`session-archive: second delete failed for ${sessionId}: ${String(error)}`);
              failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
              return;
            }
            if (await filePresentAfterSettle(path, settleMs)) {
              failed.push({ sessionId, reason: 'reappeared' });
              return;
            }
          }
          markDeleted(sessionId);
        } catch (error) {
          failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
        }
      };

      for (const sessionId of unique) {
        const id = sessionId as SessionId;
        if (!archived.has(sessionId)) {
          failed.push({ sessionId, reason: 'not-archived' });
          continue;
        }
        // 无独立的 'live' 检查:本端点只删归档成员,而归档成员按 isLive 的
        // 定义(内存存在且未归档)恒非 live——「内存中仍挂着的归档会话」的
        // 删除保护由 deleteLocatedFile 的 busy 沉降观察承担(活跃生成流会
        // 被增长判定拒绝),不是 live 判定。此前的 'live' 分支在该前置检查
        // 之后永不可达(死代码),已删;词表保留 'busy'/'not-archived'。
        if (snapshots.get(sessionId) === undefined) {
          // ghost id(枚举不到)。"枚举不到 ≠ 文件不存在":首行损坏的日志会被
          // persistence 静默跳过;而 jsonl 后端按 cwd 分目录,ghost 探测没有
          // header、拿不到 cwd,locate 只能探缺省目录(_no-cwd 一类)——既探
          // 不到真实文件,也确认不了缺失。因此 ghost 一律不能当"已删"报成功
          // (0.3.9 谎报成功的同源变体),计入 failed;ghost id 留在归档集合,
          // 由 list() 的存在性过滤隐藏,面板与侧边栏均不可见。
          failed.push({ sessionId, reason: 'unenumerable' });
          continue;
        }
        const header = snapshots.get(sessionId)!.header;
        const file = await fileInfo(header);
        if (file.state === 'unknown') {
          // 文件存在(枚举得到)但无法定位路径:删不得也不该谎报成功。
          failed.push({ sessionId, reason: 'unlocatable' });
          continue;
        }
        // ── 与 unarchive 的 confirm → unarchiveSession 互斥的删除临界区（exclusive）。
        // rm 及其全部前置判定（含 absent 复核）都在窗口内：unarchive 要么
        // 整体先落地（此处复验归档成员资格失败、拒绝删除），要么整体等删除
        // 完成（confirm 探到 absent、拒绝恢复）——"文件被删的同时归档标记
        // 被移除"的错位不存在。
        if (file.state === 'absent') {
          // absent 不是无脑幂等成功:fileInfo 的目录扫描是快照,宿主格式
          // 迁移（写临时文件+rename）的瞬间目录可能扫空,报已删前锁内重扫
          // 一次;重扫发现文件在,转常规删除流。
          await exclusive(async () => {
            if (!archivedSet().has(sessionId)) {
              failed.push({ sessionId, reason: 'not-archived' });
              return;
            }
            const fresh = await fileInfo(header);
            if (fresh.state === 'unknown') {
              failed.push({ sessionId, reason: 'unlocatable' });
              return;
            }
            if (fresh.state === 'absent') {
              markDeleted(sessionId);
              return;
            }
            await deleteLocatedFile(sessionId, fresh.path);
          });
          continue;
        }
        await exclusive(async () => {
          // 归档成员锁内复验:快照之后、删除之前,unarchive 可能已把 id 移出
          // 集合——删除先行发起也不能清掉刚恢复的会话文件。
          if (!archivedSet().has(sessionId)) {
            failed.push({ sessionId, reason: 'not-archived' });
            return;
          }
          await deleteLocatedFile(sessionId, file.path);
        });
      }
      return { deleted, failed, removedFromArchive: 0, needsRestart };
    },

    /**
     * 批量恢复归档会话（仅从归档集合移除，会话数据不动）。只恢复仍存在
     * 持久化文件的会话：文件已删的 ghost id（已彻底删除的会话）拒绝恢复，
     * 避免删除后的会话再次出现在侧边栏对话列表。
     *
     * 与 delete 对称的失败语义（failed[].reason）：'not-archived' 非归档
     * 成员；'unenumerable' 持久化枚举不到（文件已删/首行损坏）；其余为
     * confirm 复核淘汰（'not-restorable'）或底层错误消息。restored 之外的
     * 每个请求 id 都必须在 failed 里有下落——客户端据此把「已恢复 0 个」
     * 渲染为失败而非成功。
     */
    async unarchive(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const archived = archivedSet();
      const snapshots = await snapshotsByIds(unique.filter((id) => archived.has(id)));
      const failed: Array<{ sessionId: string; reason: string }> = [];
      // 锁外先做一遍廉价过滤(明显不可恢复的直接淘汰),锁内由 confirm 复核,
      // 消除与并发 deleteArchived 的检查-移除窗口。
      const candidates: string[] = [];
      for (const sessionId of unique) {
        if (!archived.has(sessionId)) {
          failed.push({ sessionId, reason: 'not-archived' });
          continue;
        }
        if (snapshots.get(sessionId) === undefined) {
          failed.push({ sessionId, reason: 'unenumerable' }); // 持久化记录已删：拒绝恢复
          continue;
        }
        candidates.push(sessionId);
      }
      const restored = await removeFromArchiveSet(candidates, async (sessionId) => {
        try {
          const snapshot = snapshots.get(sessionId);
          if (snapshot === undefined) return false;
          const file = await fileInfo(snapshot.header);
          if (file.state !== 'located') {
            // located 才确认文件在:absent(快照后文件消失)/unknown(无法确认)
            // 谨慎拒绝,并如实计入 failed。
            failed.push({ sessionId, reason: 'not-restorable' });
            return false;
          }
          return true;
        } catch {
          // confirm 路径任何意外异常等价于"不可恢复":必须给这个 id 一个
          // failed 下落(reason 复用 not-restorable),否则它既不在 restored
          // 也不在 failed,违反"restored 之外的每个请求 id 都必须有下落"的
          // 约定。fileInfo 自身全路径兜底,此分支当前不可达——防的是宿主
          // 契约漂移时的静默丢失。
          failed.push({ sessionId, reason: 'not-restorable' });
          return false;
        }
      });
      return { restored, failed, removedFromArchive: restored.length };
    },
  }
}
