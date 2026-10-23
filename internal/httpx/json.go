package httpx

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
)

func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return DecodeLimit(w, r, v, 1<<20)
}

func DecodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		WriteError(w, 400, "请求格式不正确："+err.Error())
		return false
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		WriteError(w, 400, "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}

func DbError(w http.ResponseWriter, err error) {
	log.Print(err)
	WriteError(w, 500, "保存数据失败，请查看服务日志")
}
