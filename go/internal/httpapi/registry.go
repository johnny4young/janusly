// The pilot's annotated route registry — the Open/Closed equivalent of the
// reference's Route[] table. Enforcement is CENTRAL: the auth middleware
// looks up the matched mux pattern (http.Request.Pattern, Go 1.22+) here
// and runs requireRole then requirePermission, so a mount cannot forget
// its gates — an unlisted pattern is caught by the registry completeness
// test, not by an attacker.
//
// Pairs come from the reference's route annotations verbatim. Routes with an
// empty tenant gate are auth-only (membership required, no rank/permission).
// Bootstrap identity and optional-identity routes have separate closed
// registries below.
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/johnny4young/janusly/go/internal/auth"
)

// authOnlyRoutes are the ONLY patterns allowed to pass the middleware
// with identity but no rank/permission gate (the reference's contract:
// every member reads runtime config and the catalogs). Any OTHER pattern
// missing from routeAuthz fails CLOSED with route_not_registered — a
// mount can no longer silently become auth-only by forgetting its entry.
var authOnlyRoutes = map[string]bool{
	"GET /org/config":   true,
	"GET /templates":    true,
	"GET /v1/templates": true,
	"GET /tools":        true,
	"GET /v1/tools":     true,
	// Read-only AI posture probe (reference ai-health-route.ts has no gate).
	"GET /ai/health": true,
	// Billing reads carry no gate in the reference (billing-routes.ts).
	"GET /billing/usage":        true,
	"GET /billing/usage/export": true,
	"GET /billing/budget":       true,
	"POST /users/me":            true,
}

var identityOnlyRoutes = map[string]bool{
	"GET /auth/context":               true,
	"GET /organizations":              true,
	"POST /organizations":             true,
	"POST /auth/invitations/accept":   true,
	"POST /auth/session/organization": true,
}

var optionalIdentityRoutes = map[string]bool{
	"GET /auth/session": true,
}

// route registers the gate and mounts the handler in ONE call — the
// colocated pattern new modules use (T-525). Re-registering the same
// pattern with the same gate is idempotent (harnesses build many
// handlers per process); a CONFLICTING gate is a programming error.
func (s *V1Server) route(mux *http.ServeMux, pattern string, gate routeGate, handler handlerFunc) {
	if existing, present := routeAuthz[pattern]; present && existing != gate {
		panic(fmt.Sprintf("route %s registered twice with conflicting gates", pattern))
	}
	routeAuthz[pattern] = gate
	mux.HandleFunc(pattern, s.auth(handler))
}

var routeAuthz = map[string]routeGate{
	// Workflows — version writes are editor + workflows.write.
	"POST /v1/workflows/save":              {auth.RoleEditor, "workflows.write"},
	"POST /workflows/save":                 {auth.RoleEditor, "workflows.write"},
	"POST /v1/workflows/rollback":          {auth.RoleEditor, "workflows.write"},
	"POST /workflows/rollback":             {auth.RoleEditor, "workflows.write"},
	"POST /v1/workflows/readiness":         {auth.RoleEditor, "workflows.write"},
	"POST /workflows/readiness":            {auth.RoleEditor, "workflows.write"},
	"POST /v1/validate":                    {auth.RoleEditor, "workflows.write"},
	"POST /validate":                       {auth.RoleEditor, "workflows.write"},
	"DELETE /workflows/{workflowId}":       {auth.RoleEditor, "workflows.write"},
	"POST /workflows/{workflowId}/restore": {auth.RoleEditor, "workflows.write"},
	"GET /v1/workflows":                    {auth.RoleViewer, "workflows.read"},
	"GET /workflows":                       {auth.RoleViewer, "workflows.read"},
	"GET /v1/workflows/latest":             {auth.RoleViewer, "workflows.read"},
	"GET /workflows/latest":                {auth.RoleViewer, "workflows.read"},
	"GET /v1/workflows/versions":           {auth.RoleViewer, "workflows.read"},
	"GET /workflows/versions":              {auth.RoleViewer, "workflows.read"},
	"GET /workflows/trash":                 {auth.RoleViewer, "workflows.read"},

	// Runs.
	"POST /v1/start":           {auth.RoleEditor, "runs.start"},
	"POST /start":              {auth.RoleEditor, "runs.start"},
	"POST /v1/resume":          {auth.RoleEditor, "runs.start"},
	"POST /resume":             {auth.RoleEditor, "runs.start"},
	"POST /v1/run/cancel":      {auth.RoleEditor, "runs.cancel"},
	"POST /run/cancel":         {auth.RoleEditor, "runs.cancel"},
	"POST /v1/runs/redrive":    {auth.RoleEditor, "runs.start"},
	"POST /runs/redrive":       {auth.RoleEditor, "runs.start"},
	"GET /v1/run":              {auth.RoleViewer, "runs.read"},
	"GET /run":                 {auth.RoleViewer, "runs.read"},
	"GET /v1/status":           {auth.RoleViewer, "runs.read"},
	"GET /status":              {auth.RoleViewer, "runs.read"},
	"GET /v1/runs":             {auth.RoleViewer, "runs.read"},
	"GET /runs":                {auth.RoleViewer, "runs.read"},
	"GET /runs/{runId}/stream": {auth.RoleViewer, "runs.read"},
	"GET /run/usage":           {auth.RoleViewer, "runs.read"},

	// Reports.
	"POST /reports/run-explain/deliver": {auth.RoleEditor, "reports.deliver"},

	// Triggers.
	"POST /triggers/webhook/ingest":  {auth.RoleEditor, "triggers.ingest"},
	"POST /v1/webhooks/{workflowId}": {auth.RoleEditor, "triggers.ingest"},
	"POST /v1/triggers/email/ingest": {auth.RoleEditor, "triggers.ingest"},
	"POST /v1/triggers/file/ingest":  {auth.RoleEditor, "triggers.ingest"},
	"POST /v1/triggers/mcp/ingest":   {auth.RoleEditor, "triggers.ingest"},

	// DLQ + recovery.
	"GET /v1/dlq":                                  {auth.RoleViewer, "dlq.read"},
	"GET /dlq":                                     {auth.RoleViewer, "dlq.read"},
	"GET /dlq/counts":                              {auth.RoleViewer, "dlq.read"},
	"GET /dlq/queue":                               {auth.RoleViewer, "dlq.read"},
	"GET /dlq/cluster-members":                     {auth.RoleViewer, "dlq.read"},
	"POST /dlq/resolve":                            {auth.RoleEditor, "recovery.write"},
	"POST /dlq/bulk-resolve":                       {auth.RoleEditor, "recovery.write"},
	"POST /dlq/bulk-replay":                        {auth.RoleEditor, "dlq.replay"},
	"POST /dlq/cluster-apply":                      {auth.RoleEditor, "dlq.replay"},
	"GET /v1/dlq/clusters":                         {auth.RoleViewer, "dlq.read"},
	"GET /dlq/clusters":                            {auth.RoleViewer, "dlq.read"},
	"POST /v1/dlq/redrive":                         {auth.RoleEditor, "dlq.replay"},
	"POST /v1/dlq/replay":                          {auth.RoleEditor, "dlq.replay"},
	"POST /v1/dlq/validate-fix":                    {auth.RoleEditor, "recovery.write"},
	"POST /workflows/{id}/resume":                  {auth.RoleEditor, "workflows.write"},
	"POST /recovery/playbooks":                     {auth.RoleEditor, "recovery.write"},
	"GET /recovery/playbooks/match":                {auth.RoleViewer, "recovery.read"},
	"GET /recovery/drills/outcome":                 {auth.RoleViewer, "recovery.read"},
	"GET /recovery/drills/dossier":                 {auth.RoleViewer, "recovery.read"},
	"POST /recovery/feedback":                      {auth.RoleEditor, "recovery.write"},
	"GET /recovery/calibrations":                   {auth.RoleViewer, "recovery.read"},
	"GET /recovery/items":                          {auth.RoleViewer, "recovery.read"},
	"GET /recovery/items/{id}":                     {auth.RoleViewer, "recovery.read"},
	"GET /recovery/home":                           {auth.RoleViewer, "recovery.read"},
	"GET /integrations/slack/interactions":         {auth.RoleAdmin, "credentials.write"},
	"POST /integrations/slack/interactions":        {auth.RoleAdmin, "credentials.write"},
	"POST /integrations/slack/interactions/{id}":   {auth.RoleAdmin, "credentials.write"},
	"DELETE /integrations/slack/interactions/{id}": {auth.RoleAdmin, "credentials.write"},
	"GET /integrations/external-runtimes":          {auth.RoleViewer, "external-runtimes.read"},
	"POST /integrations/external-runtimes":         {auth.RoleAdmin, "external-runtimes.write"},
	"POST /integrations/external-runtimes/{id}":    {auth.RoleAdmin, "external-runtimes.write"},
	"DELETE /integrations/external-runtimes/{id}":  {auth.RoleAdmin, "external-runtimes.write"},
	"GET /upstream/sources":                        {auth.RoleViewer, "upstream.read"},
	"POST /upstream/sources":                       {auth.RoleAdmin, "upstream.write"},
	"POST /upstream/sources/{id}":                  {auth.RoleAdmin, "upstream.write"},
	"DELETE /upstream/sources/{id}":                {auth.RoleAdmin, "upstream.write"},
	"POST /upstream/sources/{id}/check":            {auth.RoleAdmin, "upstream.write"},
	"GET /auto-healing/pending":                    {auth.RoleViewer, "autohealing.read"},
	"GET /auto-healing/{id}":                       {auth.RoleViewer, "autohealing.read"},
	"POST /auto-healing/{id}/decide":               {auth.RoleEditor, "autohealing.decide"},
	"POST /auto-healing/scan":                      {auth.RoleAdmin, "autohealing.decide"},
	"GET /workflows/{workflowId}/schedule-history": {auth.RoleViewer, "workflows.read"},
	"GET /snippets":                                {auth.RoleViewer, "snippets.read"},
	"POST /snippets":                               {auth.RoleAdmin, "snippets.write"},
	"POST /snippets/{id}":                          {auth.RoleAdmin, "snippets.write"},
	"DELETE /snippets/{id}":                        {auth.RoleAdmin, "snippets.write"},
	"POST /snippets/{id}/inserted":                 {auth.RoleEditor, "snippets.read"},
	"GET /solution-packs":                          {auth.RoleViewer, "packs.read"},
	"GET /solution-packs/{id}":                     {auth.RoleViewer, "packs.read"},
	"POST /workflows/import-pack":                  {auth.RoleEditor, "packs.install"},
	"POST /solution-packs/{id}/sample-run":         {auth.RoleEditor, "packs.install"},
	"POST /solution-packs/{id}/inject-failure":     {auth.RoleEditor, "packs.install"},
	"GET /onboarding":                              {auth.RoleViewer, "onboarding.read"},
	"POST /onboarding":                             {auth.RoleViewer, "onboarding.write"},
	"GET /workflows/health":                        {auth.RoleViewer, "workflows.read"},
	"GET /workflows/health/delta":                  {auth.RoleViewer, "workflows.read"},

	// F1 terminal-sweep closures (T-183): the missing wires the web reads.
	"GET /v1/workflows/health":                                    {auth.RoleViewer, "workflows.read"},
	"GET /v1/run/usage":                                           {auth.RoleViewer, "runs.read"},
	"GET /v1/workflows/schedule-preview":                          {auth.RoleViewer, "workflows.read"},
	"GET /workflows/schedule-preview":                             {auth.RoleViewer, "workflows.read"},
	"GET /v1/memory/consent-status":                               {auth.RoleViewer, "recovery.read"},
	"GET /memory/consent-status":                                  {auth.RoleViewer, "recovery.read"},
	"GET /mcp/connections":                                        {auth.RoleViewer, "mcp.connections.read"},
	"GET /workflows/{workflowId}/metadata":                        {auth.RoleViewer, "workflows.read"},
	"POST /workflows/{workflowId}/metadata":                       {auth.RoleEditor, "workflows.write"},
	"POST /workflows/{workflowId}/folder":                         {auth.RoleEditor, "workflows.write"},
	"POST /workflows/{workflowId}/tags":                           {auth.RoleEditor, "workflows.write"},
	"GET /workflows/tags":                                         {auth.RoleViewer, "workflows.read"},
	"GET /workflows/folders":                                      {auth.RoleViewer, "workflows.read"},
	"POST /workflows/folders/rename":                              {auth.RoleEditor, "workflows.write"},
	"POST /workflows/folders/delete":                              {auth.RoleEditor, "workflows.write"},
	"POST /workflows/folders/assign":                              {auth.RoleEditor, "workflows.write"},
	"POST /workflows/tags/assign":                                 {auth.RoleEditor, "workflows.write"},
	"POST /workflows/tags/rename":                                 {auth.RoleEditor, "workflows.write"},
	"POST /workflows/tags/delete":                                 {auth.RoleEditor, "workflows.write"},
	"GET /eval/datasets":                                          {auth.RoleViewer, "evals.read"},
	"POST /eval/datasets":                                         {auth.RoleAdmin, "evals.write"},
	"GET /eval/datasets/{id}":                                     {auth.RoleViewer, "evals.read"},
	"GET /eval/datasets/{id}/export":                              {auth.RoleViewer, "evals.read"},
	"DELETE /eval/datasets/{id}":                                  {auth.RoleAdmin, "evals.write"},
	"GET /experiments":                                            {auth.RoleViewer, "evals.read"},
	"GET /experiments/{id}":                                       {auth.RoleViewer, "evals.read"},
	"POST /experiments/run":                                       {auth.RoleAdmin, "evals.write"},
	"GET /credentials":                                            {auth.RoleViewer, "credentials.read"},
	"GET /credentials/health":                                     {auth.RoleViewer, "credentials.read"},
	"POST /credentials":                                           {auth.RoleAdmin, "credentials.write"},
	"POST /credentials/{name}/bulk-update":                        {auth.RoleAdmin, "credentials.write"},
	"DELETE /credentials/{name}":                                  {auth.RoleAdmin, "credentials.write"},
	"POST /credentials/{name}/expiry":                             {auth.RoleAdmin, "credentials.write"},
	"GET /reports/run-explain":                                    {auth.RoleViewer, "reports.read"},
	"GET /workflows/{workflowId}/rollout":                         {auth.RoleViewer, "workflows.read"},
	"POST /workflows/{workflowId}/rollout":                        {auth.RoleAdmin, "workflows.write"},
	"POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}": {auth.RoleAdmin, "workflows.write"},
	"GET /workflows/{workflowId}/rollout/qualification":           {auth.RoleViewer, "workflows.read"},
	"POST /workflows/{workflowId}/rollout/qualification":          {auth.RoleAdmin, "workflows.write"},
	"POST /recovery/items/{id}/evidence":                          {auth.RoleEditor, "recovery.read"},
	"GET /alerts/policies":                                        {auth.RoleViewer, "alerts.read"},
	"POST /alerts/policies":                                       {auth.RoleAdmin, "alerts.write"},
	"GET /alerts/recent":                                          {auth.RoleViewer, "alerts.read"},
	"POST /alerts/policies/{id}":                                  {auth.RoleAdmin, "alerts.write"},
	"DELETE /alerts/policies/{id}":                                {auth.RoleAdmin, "alerts.write"},
	"POST /recovery/items/{id}/{action}":                          {auth.RoleEditor, "recovery.write"},
	"POST /recovery/playbooks/{id}/activate":                      {auth.RoleEditor, "recovery.write"},
	"POST /recovery/playbooks/{id}/retire":                        {auth.RoleEditor, "recovery.write"},
	"POST /v1/workflows/{id}/resume":                              {auth.RoleEditor, "workflows.write"},
	"POST /dlq/validate-fix":                                      {auth.RoleEditor, "recovery.write"},
	"POST /dlq/replay":                                            {auth.RoleEditor, "dlq.replay"},
	"GET /v1/recovery/metrics":                                    {auth.RoleViewer, "dlq.read"},
	"GET /recovery/metrics":                                       {auth.RoleViewer, "dlq.read"},

	// Audit trail: admin-only compliance surface (reference pair verbatim).
	"GET /audit": {auth.RoleAdmin, "org.config.write"},

	// Org config: the read is auth-only (every member sees effective
	// settings); the write is the admin pair from the reference.
	"POST /org/config": {auth.RoleAdmin, "org.config.write"},

	// WorkOS SSO connection administration. The public start/callback routes
	// are state- and provider-authorized and therefore do not enter this
	// tenant-auth registry.
	"GET /org/sso/connections":         {auth.RoleAdmin, "org.config.write"},
	"POST /org/sso/connections":        {auth.RoleAdmin, "org.config.write"},
	"POST /org/sso/connections/{id}":   {auth.RoleAdmin, "org.config.write"},
	"DELETE /org/sso/connections/{id}": {auth.RoleAdmin, "org.config.write"},

	// AI surfaces (reference permission pairs).
	"POST /ai/generate-workflow": {auth.RoleViewer, "ai.write"},
	"POST /ai/patch-workflow":    {auth.RoleEditor, "ai.write"},

	// MCP connections admin surface (reference pairs verbatim).
	"POST /mcp/connections":                          {auth.RoleAdmin, "mcp.connections.write"},
	"POST /mcp/connections/{alias}/tools/{toolName}": {auth.RoleAdmin, "mcp.connections.write"},

	// PromptOps registry (reference pairs: read for all, write editor+).
	"GET /prompts":                                {auth.RoleViewer, "prompts.read"},
	"POST /prompts":                               {auth.RoleViewer, "prompts.write"},
	"POST /prompts/{name}/versions":               {auth.RoleViewer, "prompts.write"},
	"POST /prompts/{name}/versions/{version}/pin": {auth.RoleViewer, "prompts.write"},

	// System infrastructure snapshots (reference pairs verbatim).
	"GET /system/queue":        {auth.RoleAdmin, "org.config.write"},
	"GET /system/rate-limiter": {auth.RoleAdmin, "org.config.write"},

	// Members + invitations (reference pairs verbatim).
	"GET /members":                          {auth.RoleViewer, "members.read"},
	"GET /members/invitations":              {auth.RoleAdmin, "members.read"},
	"POST /members/invite":                  {auth.RoleAdmin, "members.write"},
	"POST /members/invitations/{id}/revoke": {auth.RoleAdmin, "members.write"},
	"POST /members/role":                    {auth.RoleAdmin, "members.role_set"},
	"DELETE /members":                       {auth.RoleAdmin, "members.write"},

	// Roles + permission overrides.
	"GET /org/permissions/catalog": {auth.RoleViewer, "members.read"},
	"GET /org/roles":               {auth.RoleViewer, "members.read"},
	"POST /org/roles":              {auth.RoleAdmin, "org.permissions.write"},
	"POST /org/roles/{name}":       {auth.RoleAdmin, "org.permissions.write"},
	"DELETE /org/roles/{name}":     {auth.RoleAdmin, "org.permissions.write"},

	// SCIM directory sync (reference scim-routes.ts annotations verbatim;
	// the WorkOS webhook receiver is public + signature-authorized so it
	// lives outside this table, like the Slack/PagerDuty callbacks).
	"GET /org/scim/directories":                 {auth.RoleViewer, "members.read"},
	"POST /org/scim/directories":                {auth.RoleAdmin, "org.config.write"},
	"POST /org/scim/directories/{id}":           {auth.RoleAdmin, "org.config.write"},
	"DELETE /org/scim/directories/{id}":         {auth.RoleAdmin, "org.config.write"},
	"GET /org/scim/groups":                      {auth.RoleViewer, "members.read"},
	"GET /org/scim/group-role-mappings":         {auth.RoleViewer, "members.read"},
	"POST /org/scim/group-role-mappings":        {auth.RoleAdmin, "members.role_set"},
	"POST /org/scim/group-role-mappings/{id}":   {auth.RoleAdmin, "members.role_set"},
	"DELETE /org/scim/group-role-mappings/{id}": {auth.RoleAdmin, "members.role_set"},
	"POST /org/scim/resync":                     {auth.RoleAdmin, "members.role_set"},

	// Replay campaigns.
	"POST /recovery/campaigns":             {auth.RoleEditor, "dlq.replay"},
	"POST /recovery/campaigns/preview":     {auth.RoleEditor, "dlq.replay"},
	"POST /recovery/campaigns/{id}/cancel": {auth.RoleEditor, "dlq.replay"},
	"GET /recovery/campaigns":              {auth.RoleViewer, "dlq.read"},
	"GET /recovery/campaigns/{id}":         {auth.RoleViewer, "dlq.read"},
}
