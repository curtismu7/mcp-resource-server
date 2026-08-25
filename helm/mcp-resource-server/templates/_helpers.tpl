{{/*
Chart name.
*/}}
{{- define "mcp-resource-server.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name: <release>-<chart>, or just <release> when it already contains the chart name.
*/}}
{{- define "mcp-resource-server.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "mcp-resource-server.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "mcp-resource-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "mcp-resource-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-resource-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mcp-resource-server.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/*
The audience inbound tokens must carry: values.resourceUri, else https://<ingress.host>
when the ingress is enabled, else a hard error.
*/}}
{{- define "mcp-resource-server.resourceUri" -}}
{{- if .Values.resourceUri -}}
{{- .Values.resourceUri -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "https://%s" (required "ingress.host is required when ingress.enabled is true" .Values.ingress.host) -}}
{{- else -}}
{{- required "resourceUri is required (the audience inbound tokens carry) unless ingress.enabled derives it from ingress.host" .Values.resourceUri -}}
{{- end -}}
{{- end -}}
