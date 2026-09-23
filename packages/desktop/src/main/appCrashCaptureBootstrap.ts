import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在 appARMSBootstrap 之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// M0 仅在隔离的数据目录保留本地 dump，不启动远端 crash 上报。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
