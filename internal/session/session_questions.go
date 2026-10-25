package session

const chatQuestionInstructions = "需要用户补充信息或选择方案时，优先使用 request_user_input 发起结构化问询，问题和选项会显示在当前会话输入区；不要只把需要用户作答的问题和选项写成普通回复。能够根据上下文合理决定的细节直接继续，不为常规实现选择反复问询。"

// Limit this override to threads started or resumed by Work Hub; do not edit
// the user's global Codex config or change collaboration/approval modes.
func chatQuestionConfig() map[string]any {
	return map[string]any{"features.default_mode_request_user_input": true}
}
