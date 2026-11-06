/** 真实建库的用例与其钩子共用；托管 Windows runner 偶发 20 到 25 秒的磁盘卡顿（#582 run 41891824229、#592 run 42073849329），取其约两倍。 */
export const WINDOWS_RUNNER_IO_STALL_TIMEOUT_MS = 60_000
