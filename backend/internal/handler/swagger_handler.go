package handler

import (
	_ "embed"
	"net/http"
)

// SwaggerHandler serves Swagger UI and OpenAPI 3.0 specification.
type SwaggerHandler struct {
	specJSON []byte
}

func NewSwaggerHandler(specJSON []byte) *SwaggerHandler {
	return &SwaggerHandler{specJSON: specJSON}
}

func (h *SwaggerHandler) ServeSpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(h.specJSON)
}

func (h *SwaggerHandler) ServeUI(w http.ResponseWriter, r *http.Request) {
	html := `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ComCamp #25 API Documentation · Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <link rel="icon" type="image/png" href="https://raw.githubusercontent.com/swagger-api/swagger-ui/master/dist/favicon-32x32.png" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; font-family: sans-serif; }
    .topbar { display: none !important; }
    .swagger-ui .info { margin: 25px 0; }
    .swagger-ui .info .title { font-size: 32px; color: #1e293b; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        persistAuthorization: true
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; img-src 'self' https://raw.githubusercontent.com data:; connect-src 'self'")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(html))
}
