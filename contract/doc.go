// Package contractdoc embeds the generated OpenAPI document so the Go
// candidate serves the same checked-in artifact its drift gate validates.
package contractdoc

import _ "embed"

// OpenAPI is generated from the side-effect-free internal contract manifest.
//
//go:embed openapi.json
var OpenAPI []byte
