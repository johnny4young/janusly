package contract

// opaqueJSON is an undescribed JSON value. Each use is a distinct named
// fragment so the closed-schema gate demands a reason per group.
func opaqueJSON() map[string]any { return map[string]any{} }

var (
	runJSON              = opaqueJSON()
	dlqSnapshot          = opaqueJSON()
	storedColumnJSON     = opaqueJSON()
	recoveryEvidenceJSON = opaqueJSON()
	workflowParsedJSON   = opaqueJSON()
	memoryMetadata       = opaqueJSON()
	runInput             = opaqueJSON()
	replacementOutput    = opaqueJSON()
)
