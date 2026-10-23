package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"worktree-hub/internal/httpx"
)

// IDs refer to choices retained on the server. The browser never supplies RPC
// decisions, permission grants, or persistence metadata of its own.
type ChatApprovalChoice struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Accepts     bool   `json:"accepts"`
	decision    json.RawMessage
	persist     string
}

type ChatElicitation struct {
	Mode         string          `json:"mode"`
	ServerName   string          `json:"server_name"`
	URL          string          `json:"url,omitempty"`
	Fields       []ChatFormField `json:"fields,omitempty"`
	JSONFallback bool            `json:"json_fallback,omitempty"`
	Schema       json.RawMessage `json:"schema,omitempty"`
	Error        string          `json:"error,omitempty"`
	schema       *jsonschema.Schema
	toolApproval bool
}

type ChatFormOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type ChatFormField struct {
	Name        string           `json:"name"`
	Title       string           `json:"title"`
	Description string           `json:"description,omitempty"`
	Type        string           `json:"type"`
	Required    bool             `json:"required"`
	Options     []ChatFormOption `json:"options,omitempty"`
	Default     json.RawMessage  `json:"default,omitempty"`
	Format      string           `json:"format,omitempty"`
	Minimum     *float64         `json:"minimum,omitempty"`
	Maximum     *float64         `json:"maximum,omitempty"`
	MinLength   *int             `json:"min_length,omitempty"`
	MaxLength   *int             `json:"max_length,omitempty"`
}

type chatApprovalInput struct {
	RunID      string              `json:"run_id"`
	ApprovalID string              `json:"approval_id"`
	Decision   string              `json:"decision"`
	Answers    map[string][]string `json:"answers"`
	Content    json.RawMessage     `json:"content,omitempty"`
}

// The URL is taken from the pending server request, never from HTTP input.
// Opening the browser does not resolve or approve the elicitation.
func (a *Service) ChatApprovalOpenHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RunID      string `json:"run_id"`
		ApprovalID string `json:"approval_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	run := a.ControlledRun(w, r, input.RunID)
	if run == nil {
		return
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if !run.state.Busy || run.state.Status == "stopping" {
		httpx.WriteError(w, 409, "此运行已经结束")
		return
	}
	for _, approval := range run.state.Approvals {
		if approval.ID != input.ApprovalID {
			continue
		}
		if !approval.CanAccept || approval.Elicitation == nil || approval.Elicitation.Mode != "url" || approval.Elicitation.URL == "" {
			httpx.WriteError(w, 400, "此交互没有可打开的链接")
			return
		}
		if err := a.openExternal(approval.Elicitation.URL); err != nil {
			httpx.WriteError(w, 503, "无法打开浏览器："+err.Error())
			return
		}
		httpx.WriteJSON(w, 200, map[string]string{"message": "已请求打开浏览器，请完成操作后回到侧栏确认"})
		return
	}
	httpx.WriteError(w, 409, "此交互已被处理或失效")
}

type localSchemaLoader struct{}

func (localSchemaLoader) Load(location string) (any, error) {
	return nil, fmt.Errorf("表单不可引用外部 schema：%s", location)
}

func makeElicitation(a *ChatApproval) {
	var p struct {
		ServerName string          `json:"serverName"`
		Mode       string          `json:"mode"`
		Message    string          `json:"message"`
		URL        string          `json:"url"`
		Schema     json.RawMessage `json:"requestedSchema"`
		Meta       struct {
			Kind    string          `json:"codex_approval_kind"`
			Persist json.RawMessage `json:"persist"`
		} `json:"_meta"`
		Request json.RawMessage `json:"request"`
	}
	_ = json.Unmarshal(a.params, &p)
	// Older app-server versions wrapped the elicitation payload in request.
	if len(p.Request) > 0 {
		_ = json.Unmarshal(p.Request, &p)
	}
	e := &ChatElicitation{Mode: p.Mode, ServerName: p.ServerName, toolApproval: p.Meta.Kind == "mcp_tool_call"}
	a.Kind, a.Title, a.Details, a.Elicitation = "elicitation", "外部工具需要你的确认", p.Message, e
	a.Choices = []ChatApprovalChoice{{ID: "decline", Label: "拒绝"}, {ID: "cancel", Label: "取消本次交互"}}
	a.CanAccept = false
	switch p.Mode {
	case "url":
		parsed, err := url.Parse(p.URL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			e.Error = "工具返回的链接不可打开，请拒绝或取消本次交互。"
			return
		}
		e.URL = p.URL
		a.Title = "外部工具需要在浏览器中完成操作"
		a.Choices = append(a.Choices, ChatApprovalChoice{ID: "accept", Label: "已完成，继续", Accepts: true})
	case "form", "openai/form", "openaiForm":
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(p.Schema))
		if err != nil {
			e.Error = "工具返回的表单格式不正确，请拒绝或取消本次交互。"
			return
		}
		compiler := jsonschema.NewCompiler()
		compiler.UseLoader(localSchemaLoader{})
		compiler.AssertFormat()
		const location = "https://worktree-hub.invalid/elicitation.json"
		if err = compiler.AddResource(location, doc); err == nil {
			e.schema, err = compiler.Compile(location)
		}
		if err != nil {
			e.Error = "暂无法解析此表单的校验规则，请拒绝或取消后在终端处理。"
			return
		}
		e.Fields, e.JSONFallback = elicitationFields(p.Schema)
		if e.JSONFallback {
			e.Schema = p.Schema
		}
		label := "提交回答"
		if p.Meta.Kind == "mcp_tool_call" {
			a.Title, label = "允许外部工具调用？", "允许一次"
		}
		a.Choices = append(a.Choices, ChatApprovalChoice{ID: "accept", Label: label, Accepts: true})
		if p.Meta.Kind == "mcp_tool_call" {
			var scopes []string
			var scope string
			if json.Unmarshal(p.Meta.Persist, &scope) == nil {
				scopes = []string{scope}
			} else {
				_ = json.Unmarshal(p.Meta.Persist, &scopes)
			}
			for _, item := range []struct{ scope, label string }{{"session", "本会话允许"}, {"always", "始终允许"}} {
				for _, scope := range scopes {
					if scope == item.scope {
						a.Choices = append(a.Choices, ChatApprovalChoice{ID: "accept_" + scope, Label: item.label, Accepts: true, persist: scope})
						break
					}
				}
			}
		}
	default:
		e.Error = "暂不支持此工具的交互类型，请拒绝或取消后在终端处理。"
		return
	}
	a.CanAccept = true
}

func elicitationFields(raw json.RawMessage) ([]ChatFormField, bool) {
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || string(root["type"]) != `"object"` {
		return nil, true
	}
	// Complex schemas remain answerable through a JSON editor; the server uses
	// the original schema for validation in both rendering modes.
	for _, key := range []string{"$ref", "allOf", "anyOf", "oneOf", "if", "dependentSchemas", "patternProperties"} {
		if _, exists := root[key]; exists {
			return nil, true
		}
	}
	var properties map[string]json.RawMessage
	var required []string
	if json.Unmarshal(root["properties"], &properties) != nil {
		return nil, true
	}
	_ = json.Unmarshal(root["required"], &required)
	for _, name := range required {
		if _, exists := properties[name]; !exists {
			return nil, true
		}
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	fields := make([]ChatFormField, 0, len(names))
	for _, name := range names {
		var s struct {
			Type        string          `json:"type"`
			Title       string          `json:"title"`
			Description string          `json:"description"`
			Format      string          `json:"format"`
			Default     json.RawMessage `json:"default"`
			Enum        []string        `json:"enum"`
			EnumNames   []string        `json:"enumNames"`
			OneOf       []struct {
				Value string `json:"const"`
				Title string `json:"title"`
			} `json:"oneOf"`
			Items struct {
				Type  string   `json:"type"`
				Enum  []string `json:"enum"`
				AnyOf []struct {
					Value string `json:"const"`
					Title string `json:"title"`
				} `json:"anyOf"`
			} `json:"items"`
			Minimum   *float64 `json:"minimum"`
			Maximum   *float64 `json:"maximum"`
			MinLength *int     `json:"minLength"`
			MaxLength *int     `json:"maxLength"`
		}
		if json.Unmarshal(properties[name], &s) != nil {
			return nil, true
		}
		var rules map[string]json.RawMessage
		_ = json.Unmarshal(properties[name], &rules)
		for _, key := range []string{"$ref", "allOf", "anyOf", "if", "const"} {
			if _, exists := rules[key]; exists {
				return nil, true
			}
		}
		if s.Type == "string" && len(s.OneOf) > 0 && !titledEnumOptions(rules["oneOf"]) {
			return nil, true
		}
		if s.Type == "array" && len(s.Items.AnyOf) > 0 {
			var items map[string]json.RawMessage
			_ = json.Unmarshal(rules["items"], &items)
			if !titledEnumOptions(items["anyOf"]) {
				return nil, true
			}
		}
		f := ChatFormField{Name: name, Title: s.Title, Description: s.Description, Type: s.Type, Default: s.Default, Format: s.Format, Minimum: s.Minimum, Maximum: s.Maximum, MinLength: s.MinLength, MaxLength: s.MaxLength}
		if f.Title == "" {
			f.Title = name
		}
		for _, key := range required {
			if key == name {
				f.Required = true
			}
		}
		switch s.Type {
		case "string":
			for i, value := range s.Enum {
				label := value
				if i < len(s.EnumNames) {
					label = s.EnumNames[i]
				}
				f.Options = append(f.Options, ChatFormOption{Value: value, Label: label})
			}
			for _, option := range s.OneOf {
				f.Options = append(f.Options, ChatFormOption{Value: option.Value, Label: option.Title})
			}
		case "boolean", "number", "integer":
		case "array":
			for _, value := range s.Items.Enum {
				f.Options = append(f.Options, ChatFormOption{Value: value, Label: value})
			}
			for _, option := range s.Items.AnyOf {
				f.Options = append(f.Options, ChatFormOption{Value: option.Value, Label: option.Title})
			}
			if len(f.Options) == 0 {
				return nil, true
			}
		default:
			return nil, true
		}
		fields = append(fields, f)
	}
	return fields, false
}

func titledEnumOptions(raw json.RawMessage) bool {
	var options []map[string]json.RawMessage
	if json.Unmarshal(raw, &options) != nil {
		return false
	}
	for _, option := range options {
		var value string
		if raw, exists := option["const"]; !exists || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
			return false
		}
	}
	return true
}

func approvalChoice(a *ChatApproval, id string) (ChatApprovalChoice, error) {
	for _, choice := range a.Choices {
		if choice.ID == id {
			return choice, nil
		}
	}
	if len(a.Choices) == 0 && (id == "decline" || id == "accept" && a.CanAccept) {
		return ChatApprovalChoice{ID: id, Accepts: id == "accept"}, nil
	}
	return ChatApprovalChoice{}, fmt.Errorf("此交互不支持所选操作，请刷新后重试")
}

func elicitationReply(a *ChatApproval, choice ChatApprovalChoice, content json.RawMessage) (any, error) {
	action := choice.ID
	var value any
	if choice.Accepts {
		action = "accept"
		if a.Elicitation.Mode != "url" {
			if len(content) == 0 {
				content = json.RawMessage(`{}`)
			}
			var err error
			value, err = jsonschema.UnmarshalJSON(bytes.NewReader(content))
			if err != nil {
				return nil, fmt.Errorf("表单回答必须是有效 JSON")
			}
			object, ok := value.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("表单回答必须是 JSON 对象")
			}
			if a.Elicitation.toolApproval && !a.Elicitation.JSONFallback {
				allowed := map[string]bool{}
				for _, field := range a.Elicitation.Fields {
					allowed[field.Name] = true
				}
				for name := range object {
					if !allowed[name] {
						return nil, fmt.Errorf("工具授权包含未请求的回答字段")
					}
				}
			}
			if a.Elicitation.schema == nil || a.Elicitation.schema.Validate(value) != nil {
				return nil, fmt.Errorf("回答不符合工具的表单要求，请检查必填项、格式、选项和取值范围")
			}
		}
	}
	result := map[string]any{"action": action, "content": value}
	if choice.persist != "" {
		result["_meta"] = map[string]any{"persist": choice.persist}
	}
	if action == "cancel" {
		result["_meta"] = map[string]any{"codex_approval_cancellation_reason": "user"}
	}
	return result, nil
}

func commandApprovalChoices(decisions []json.RawMessage) []ChatApprovalChoice {
	if len(decisions) == 0 {
		decisions = []json.RawMessage{json.RawMessage(`"accept"`), json.RawMessage(`"decline"`), json.RawMessage(`"cancel"`)}
	}
	choices := []ChatApprovalChoice{}
	for i, raw := range decisions {
		var id string
		_ = json.Unmarshal(raw, &id)
		choice := ChatApprovalChoice{ID: id, decision: raw}
		switch id {
		case "accept":
			choice.Label, choice.Accepts = "允许一次", true
		case "acceptForSession":
			choice.Label, choice.Accepts = "本会话允许", true
		case "decline":
			choice.Label = "拒绝"
		case "cancel":
			choice.Label = "拒绝并停止本轮"
		default:
			var amendment map[string]json.RawMessage
			_ = json.Unmarshal(raw, &amendment)
			if v, ok := amendment["acceptWithExecpolicyAmendment"]; ok {
				choice.Label, choice.Description, choice.Accepts = "允许并记住命令规则", string(v), true
			} else if v, ok := amendment["applyNetworkPolicyAmendment"]; ok {
				choice.Label, choice.Description = "应用网络规则", string(v)
			} else {
				continue
			}
			choice.ID = fmt.Sprintf("amendment-%d", i)
		}
		choices = append(choices, choice)
	}
	if len(choices) == 0 {
		return []ChatApprovalChoice{{ID: "decline", Label: "拒绝", decision: json.RawMessage(`"decline"`)}, {ID: "cancel", Label: "拒绝并停止本轮", decision: json.RawMessage(`"cancel"`)}}
	}
	return choices
}

func questionReply(questions []ChatQuestion, input chatApprovalInput) (any, error) {
	answers := map[string]any{}
	for _, q := range questions {
		values := input.Answers[q.ID]
		if input.Decision == "decline" {
			values = []string{}
		}
		if input.Decision == "accept" && (len(values) != 1 || strings.TrimSpace(values[0]) == "" || len(values[0]) > 8000) {
			return nil, fmt.Errorf("请回答每一个问题（最多 8000 字节）")
		}
		answers[q.ID] = map[string]any{"answers": values}
	}
	return map[string]any{"answers": answers}, nil
}
