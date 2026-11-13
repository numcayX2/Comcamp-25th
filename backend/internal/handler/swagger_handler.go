package handler

import (
	_ "embed"
	"net/http"
)

// SwaggerHandler serves Swagger UI and OpenAPI 3.0 specification
type SwaggerHandler struct {
	specJSON []byte
}

func NewSwaggerHandler(specJSON []byte) *SwaggerHandler {
	return &SwaggerHandler{specJSON: specJSON}
}

// setDocsHeaders hardens both docs responses: no MIME sniffing, no framing (clickjacking of the
// "Authorize" dialog), no Referer to the CDN, and no caching of a page an admin pasted a token into.
func setDocsHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
}

func (h *SwaggerHandler) ServeSpec(w http.ResponseWriter, r *http.Request) {
	setDocsHeaders(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(h.specJSON)
}

func (h *SwaggerHandler) ServeUI(w http.ResponseWriter, r *http.Request) {
	html := `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ComCamp #25 API Documentation · Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.css" crossorigin="anonymous" />
  <link rel="icon" type="image/png" href="https://raw.githubusercontent.com/swagger-api/swagger-ui/master/dist/favicon-32x32.png" />
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
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js" crossorigin="anonymous"></script>
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
        // Never keep an admin Bearer token in localStorage: it is gone when the tab closes.
        persistAuthorization: false
      });
      window.ui = ui;
    };
  </script>
</body>
</html>`

	setDocsHeaders(w)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://raw.githubusercontent.com https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(html))
}
