/**
 * 待确认候选的「一键 AI 补译名」。
 *
 * 为什么要有它：本地模型（NER）只认得出「这是个人名」，给不出中文译名；候选项到了待确认
 * 页，每张卡的「固定译文」都是空的，用户只能一条条自己翻。句子级的「AI 提取」是按单张卡
 * 走的，几百条点不过来（而且它只写 DOM，重建一次就全丢）。
 *
 * 所以这里走另一条路：后台按批问 AI（一次 20 个词），结果直接落进 pending 存档的
 * `suggestedTargets`，页面重建也不会丢。判据只有一条 —— **只补空的**，用户填过的绝不动。
 */
export function installGlossaryPendingTargets(runtime) {
  // 一章最多 200 条候选，一轮 20 条，留点余量防死循环。
  const MAX_ROUNDS_PER_CHAPTER = 12;
  // 后台单批的 LLM 超时是 90 秒，这里必须比它宽，否则会先于后台自己超时。
  const REQUEST_TIMEOUT_MS = 105000;
  let filling = false;

  function fillableCount(chapters) {
    return chapters.reduce(
      (total, chapter) => total + chapter.candidates.filter(candidate => candidate.suggestedTargets.length === 0).length,
      0
    );
  }

  /** 当前详情页范围内（当前库）还缺译名的候选数。 */
  function describeFillableTargets() {
    const chapters = runtime.scopedPendingChapters();
    return { chapters, remaining: fillableCount(chapters) };
  }
  runtime.describeFillableTargets = describeFillableTargets;

  function renderFillButton() {
    const button = runtime.aiFillTargetsBtn;
    if (!button) {
      return;
    }
    const { remaining } = describeFillableTargets();
    const configured = runtime.sentenceLlmConfigured === true;
    button.textContent = remaining > 0 ? `AI 补全译名（${remaining}）` : "AI 补全译名";
    button.disabled = filling || remaining === 0 || !configured;
    if (!configured) {
      button.title = "需要先在设置页「翻译服务」里选择句子级术语提取的配置";
    } else if (remaining > 0) {
      button.title = `给这 ${remaining} 条候选补译名，只补空的，已填写的不动`;
    } else {
      button.title = "所有候选都已有译名";
    }
  }
  runtime.renderFillButton = renderFillButton;

  /** 页面上已经手填的译名（还没提交的那些），只取有内容的。 */
  function collectDrafts(chapterKeys) {
    const scope = Array.isArray(chapterKeys) ? new Set(chapterKeys) : null;
    return Array.from(runtime.pendingChapters.querySelectorAll(".candidate-card"))
      .filter(card => !scope || scope.has(card.dataset.chapterKey))
      .map(card => ({
        source: String(card.dataset.source || "").trim(),
        target: String((card.querySelector(".candidate-target") || {}).value || "").trim()
      }))
      .filter(item => item.source && item.target);
  }

  async function fillTargetsForChapter(chapterKey, onFilled) {
    let filled = 0;
    for (let round = 1; round <= MAX_ROUNDS_PER_CHAPTER; round += 1) {
      const response = await runtime.withPendingTimeout(runtime.sendRuntimeMessage({
        type: "EXTRACT_TERM_TARGETS",
        chapterKey
      }), REQUEST_TIMEOUT_MS);
      if (!response || !response.ok) {
        throw new Error(response && response.error || "补译名失败");
      }
      filled += Number(response.filledCount) || 0;
      onFilled(filled);
      if (!(Number(response.remaining) > 0)) {
        return { filled, stuck: 0 };
      }
      if (!(Number(response.filledCount) > 0)) {
        // 一批 20 个词一条都没补出来：再问下去也是同样的结果，把剩余条数交出去。
        return { filled, stuck: Number(response.remaining) || 0 };
      }
    }
    return { filled, stuck: 0 };
  }

  async function fillTargets(chapterKeys) {
    if (filling) {
      return;
    }
    const targets = Array.isArray(chapterKeys) && chapterKeys.length > 0
      ? chapterKeys
      : runtime.scopedPendingChapters().map(chapter => chapter.key);
    if (targets.length === 0) {
      runtime.setPendingStatus("没有需要补译名的候选", true);
      return;
    }
    filling = true;
    renderFillButton();
    const total = { filled: 0, stuck: 0 };
    try {
      // 先把页面手填的值落盘：后台「只补空的」判据看的是存档，
      // 不先存的话刚填的那几条会被当成空条目重新问一遍，回填时把用户输入盖掉。
      const drafts = collectDrafts(targets);
      if (drafts.length > 0) {
        const saved = await runtime.sendRuntimeMessage({ type: "SAVE_PENDING_TARGET_DRAFTS", drafts });
        if (saved && saved.ok === false) {
          throw new Error(saved.error || "保存已填写的译名失败");
        }
      }
      for (const chapterKey of targets) {
        const result = await fillTargetsForChapter(chapterKey, filled => {
          runtime.setPendingStatus(`正在补译名…（本次已补 ${total.filled + filled} 条）`, false);
        });
        total.filled += result.filled;
        total.stuck += result.stuck;
      }
      const stuckText = total.stuck > 0 ? `，还有 ${total.stuck} 条 AI 没给出译名` : "";
      runtime.setPendingStatus(`已补 ${total.filled} 条译名${stuckText}，确认无误后点「加入所有已填写」`, total.stuck > 0);
    } catch (error) {
      runtime.setPendingStatus(`补译名失败：${runtime.getErrorMessage(error)}`, true);
    } finally {
      filling = false;
      await Promise.resolve(runtime.loadTermDiscoveryState(false)).catch(() => undefined);
      renderFillButton();
    }
  }
  runtime.fillPendingTargets = fillTargets;
  /** 章节标题行那颗按钮：只补这一话。 */
  runtime.fillChapterTargets = chapterKey => fillTargets([chapterKey]);

  function bindPendingTargetEvents() {
    if (!runtime.aiFillTargetsBtn) {
      return;
    }
    runtime.aiFillTargetsBtn.addEventListener("click", () => void fillTargets());
  }
  runtime.bindPendingTargetEvents = bindPendingTargetEvents;

  runtime.aiFillTargetsBtn = document.getElementById("aiFillTargetsBtn");
}

export default Object.freeze({ installGlossaryPendingTargets });
