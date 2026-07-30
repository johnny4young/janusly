// Command api is the go-pilot API binary. T-001 wires config, boot probe and
// observability; for T-000 it only proves the module builds and runs.
package main

import "fmt"

const version = "go-pilot-0.0.1"

func main() {
	fmt.Println("janusly " + version)
}
