package workspace

import (
	"context"
	"encoding/json"
	"fmt"
)

func (c *Client) Stream(ctx context.Context, request Request, emit func(json.RawMessage) error) error {
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return fmt.Errorf("WSL 辅助程序未连接")
	default:
	}
	c.sequence++
	id := c.sequence
	ch := make(chan Response, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	request.ID = id
	c.writeMu.Lock()
	err := json.NewEncoder(c.in).Encode(request)
	c.writeMu.Unlock()
	if err != nil {
		c.fail()
		return err
	}
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		c.writeMu.Lock()
		_ = json.NewEncoder(c.in).Encode(Request{Op: "cancel", CancelID: id})
		c.writeMu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.done:
			return fmt.Errorf("WSL 实时连接已断开")
		case response := <-ch:
			if err := response.err(); err != nil {
				return err
			}
			if !response.More {
				return nil
			}
			if err := emit(response.Data); err != nil {
				return err
			}
		}
	}
}
