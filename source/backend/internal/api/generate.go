// Package api holds the server interface, models and embedded spec generated
// from api/openapi.yaml. Don't edit api.gen.go; change the spec and run
// `make generate`.
package api

//go:generate go tool oapi-codegen -config oapi-codegen.yaml ../../../../api/openapi.yaml
