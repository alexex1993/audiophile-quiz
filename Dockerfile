# ---- build ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- runtime ----
FROM alpine:3.22
# ffmpeg does the cutting, AAC encoding and decoding.
RUN apk add --no-cache ffmpeg ca-certificates tzdata \
 && adduser -D -u 10001 app \
 && mkdir -p /data && chown app /data
COPY --from=build /out/server /usr/local/bin/server
USER app
ENV DATA_DIR=/data ADDR=:8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/server"]
