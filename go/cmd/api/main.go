// Command api is the go-pilot API binary. For now it only proves the module
// builds and runs; config, boot probe and observability arrive next.
package main

import "fmt"

const version = "go-pilot-0.0.1"

func main() {
	fmt.Println("janusly " + version)
}
