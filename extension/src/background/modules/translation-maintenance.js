/** 创建单飞维护调度器；积压写入与旧缓存迁移不得阻塞首屏读取。 */
export function createTranslationMaintenanceScheduler(runtime) {
  let maintenancePromise = null;
  return function scheduleTranslationServiceMaintenance() {
    if (maintenancePromise) return maintenancePromise;
    const jobs = [
      runtime.flushPendingTranslationOperations(), runtime.migrateLegacyTranslations()
    ];
    maintenancePromise = Promise.allSettled(jobs)
      .finally(() => { maintenancePromise = null; });
    return maintenancePromise;
  };
}
