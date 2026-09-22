package httpapi

import "encoding/json"

// Keep embedded authoring documents untouched; only their catalog envelope is
// typed here. A pointer preserves omitted versus explicitly empty credentials.
type TemplateCatalogView struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	Description         string          `json:"description"`
	Category            string          `json:"category"`
	NameCode            string          `json:"nameCode"`
	DescriptionCode     string          `json:"descriptionCode"`
	CategoryCode        string          `json:"categoryCode"`
	RequiredCredentials *[]string       `json:"requiredCredentials,omitempty"`
	Workflow            json.RawMessage `json:"workflow"`
}
