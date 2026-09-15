/**
 * 「移动到…」弹窗里的「＋ 新建术语库…」：不用先退出去建库、再回来重选一遍。
 *
 * 只管这一件事：下拉末尾那个哨兵项、跟着它显隐的名称输入、以及提交前把库建出来拿 id。
 * 真正搬条目的逻辑在 glossary-batch-actions。
 */
export const MOVE_NEW_LIBRARY_VALUE = "__new_library__";

export function installGlossaryMoveNewLibrary(runtime) {
  const moveDialog = document.getElementById("batchMoveDialog");
  const moveTargetSelect = document.getElementById("batchMoveTargetSelect");
  const moveSubmitBtn = document.getElementById("batchMoveSubmit");
  const newField = document.getElementById("batchMoveNewField");
  const newName = document.getElementById("batchMoveNewName");
  const newError = document.getElementById("batchMoveNewError");
  if (!moveDialog || !moveTargetSelect || !newField || !newName) {
    return;
  }

  function showError(message) {
    if (!newError) {
      return;
    }
    newError.textContent = String(message || "");
    newError.classList.toggle("hidden", !message);
  }
  /** 收起名称输入、清掉红字、提交按钮说回「移动」。 */
  function reset() {
    newName.value = "";
    showError("");
    newField.classList.add("hidden");
    if (moveSubmitBtn) {
      moveSubmitBtn.textContent = "移动";
    }
  }
  runtime.resetMoveNewLibrary = reset;

  /** 打开「移动到…」时调用：补上哨兵项（每次重填下拉都会把它冲掉）并复位。 */
  function prepareOption() {
    const option = document.createElement("option");
    option.value = MOVE_NEW_LIBRARY_VALUE;
    option.textContent = "＋ 新建术语库…";
    moveTargetSelect.append(option);
    reset();
  }
  runtime.prepareMoveNewLibraryOption = prepareOption;

  /** 下拉切到「＋ 新建术语库…」就展开名称输入，提交按钮也改成实话。 */
  function handleTargetChange() {
    const creating = moveTargetSelect.value === MOVE_NEW_LIBRARY_VALUE;
    newField.classList.toggle("hidden", !creating);
    if (moveSubmitBtn) {
      moveSubmitBtn.textContent = creating ? "新建并移动" : "移动";
    }
    if (creating && typeof newName.focus === "function") {
      newName.focus();
    }
  }
  runtime.handleMoveTargetChange = handleTargetChange;

  /**
   * 提交前定目标：选的是哨兵项就先把库建出来。建不出来（空名 / 重名）返回 null ——
   * 调用方要停在弹窗里报错，不能既没建库又把弹窗关了。
   * 成功返回 `{ targetId, createdName }`（createdName 非空表示这次是新建的）。
   */
  async function resolveMoveTarget() {
    const requested = moveTargetSelect.value || runtime.glossaryCore.DEFAULT_LIBRARY_ID;
    if (requested !== MOVE_NEW_LIBRARY_VALUE) {
      return { targetId: requested, createdName: "" };
    }
    const name = String(newName.value || "").trim();
    if (!name) {
      showError("请填写新术语库名称");
      newName.focus();
      return null;
    }
    const result = await runtime.saveLibrary({ name, enabled: true, urls: [] });
    if (result.ok === false) {
      showError(result.error);
      newName.focus();
      return null;
    }
    return { targetId: result.library.id, createdName: result.library.name };
  }
  runtime.resolveMoveTarget = resolveMoveTarget;

  moveTargetSelect.addEventListener("change", handleTargetChange);
  newName.addEventListener("input", () => showError(""));
  // Esc / 点遮罩关窗：新建名称一并复位，下次打开是干净的。
  moveDialog.addEventListener("close", reset);
}
