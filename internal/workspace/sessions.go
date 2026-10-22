package workspace

import (
	"context"
	"encoding/json"
)

type Sessions struct {
	Context context.Context
	Client  *Client
}

func (c *Sessions) Call(method string, params any, result any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.Client.Call(c.Context, Request{Op: "session", Method: method, Params: raw}, result)
}
func (c *Sessions) Close() {}
