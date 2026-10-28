'use strict';
// Typed controllers own async state; this bridge supplies the environment and
// existing request/mutation ports after the page's native controls are mounted.
const taskReviewController = window.WorkHubUI.createTaskReviewController({
  document,
  environment: () => activeEnvironment,
  request: api,
  mutation,
  toast,
  reviewMarkup: window.WorkHubUI.taskReview,
  changesMarkup: window.WorkHubUI.changeFiles,
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  if (button.dataset.action === 'task-review') taskReviewController.openReview(button.dataset.id);
  if (button.dataset.action === 'changes-open') taskReviewController.openChanges(button.dataset.id, button.dataset.path);
});
