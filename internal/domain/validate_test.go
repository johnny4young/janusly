package domain

// Validate keeps the concise structural-validation fixture used by this
// package's tests without exporting an unused production wrapper.
func Validate(wf *Workflow, validExpression ExpressionValidator) ValidationResult {
	return ValidateWithOptions(wf, validExpression, nil, ValidationOptions{})
}
