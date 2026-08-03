package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkPlaneGatePassesActiveRequestsAndLabelsThem(t *testing.T) {
	called := 0
	handler := WithWorkPlaneGate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called++
		w.WriteHeader(http.StatusNoContent)
	}), true)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/start", nil))
	if recorder.Code != http.StatusNoContent || called != 1 || recorder.Header().Get(WorkPlaneHeader) != "active" {
		t.Fatalf("active request: status=%d called=%d headers=%v", recorder.Code, called, recorder.Header())
	}
}

func TestWorkPlaneGateKeepsPassiveReadsAndPreflightAvailable(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		t.Run(method, func(t *testing.T) {
			called := 0
			handler := WithWorkPlaneGate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called++
				w.WriteHeader(http.StatusNoContent)
			}), false)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(method, "/v1/runs", nil))
			if recorder.Code != http.StatusNoContent || called != 1 || recorder.Header().Get(WorkPlaneHeader) != "passive" {
				t.Fatalf("passive read: status=%d called=%d headers=%v", recorder.Code, called, recorder.Header())
			}
		})
	}
}

func TestWorkPlaneGateRejectsPassiveMutationsBeforeHandler(t *testing.T) {
	for _, request := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/start"},
		{http.MethodPut, "/org/config"},
		{http.MethodDelete, "/workflows/wf"},
		{http.MethodGet, "/auth/sso/start?orgId=org"},
		{http.MethodGet, "/auth/sso/callback?code=x&state=y"},
		{http.MethodGet, "/billing/usage/export?format=csv"},
		{http.MethodGet, "/reports/run-explain?runId=run"},
		{http.MethodGet, "/eval/datasets/dataset/export?format=jsonl"},
	} {
		t.Run(request.method+" "+request.path, func(t *testing.T) {
			called := 0
			handler := WithWorkPlaneGate(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				called++
			}), false)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(request.method, request.path, nil))

			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if recorder.Code != http.StatusServiceUnavailable || called != 0 ||
				body["code"] != "go_work_plane_passive" || recorder.Header().Get("Retry-After") != "5" ||
				recorder.Header().Get(WorkPlaneHeader) != "passive" {
				t.Fatalf("passive mutation: status=%d called=%d body=%v headers=%v",
					recorder.Code, called, body, recorder.Header())
			}
		})
	}
}
