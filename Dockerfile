# Simplified Dockerfile using pre-built binaries from GitHub Releases
# Supports: linux/amd64, linux/arm64

ARG VERSION=latest

FROM debian:bookworm-slim

# Install required dependencies
RUN apt-get update && \
    apt-get install -y \
      sqlite3 \
      ca-certificates \
      curl \
      file \
      && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download the appropriate binary based on architecture
# TARGETARCH is automatically set by Docker buildx (amd64 or arm64)
ARG TARGETARCH
ARG VERSION
ARG IMAGE_SHA=unknown

# Determine correct architecture and download binary
RUN echo "=== Binary Download Information ===" && \
    echo "TARGETARCH from buildx: ${TARGETARCH}" && \
    echo "System uname -m: $(uname -m)" && \
    echo "Version: ${VERSION}" && \
    # Use TARGETARCH if set, otherwise detect from system
    if [ -z "${TARGETARCH}" ]; then \
      case "$(uname -m)" in \
        x86_64) ARCH=amd64 ;; \
        aarch64) ARCH=arm64 ;; \
        *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;; \
      esac; \
    else \
      ARCH="${TARGETARCH}"; \
    fi && \
    echo "Using architecture: ${ARCH}" && \
    if [ "${VERSION}" = "latest" ]; then \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-${ARCH}"; \
    else \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/download/v${VERSION}/better-ccflare-linux-${ARCH}"; \
    fi && \
    echo "Downloading from: ${DOWNLOAD_URL}" && \
    curl -L -f -o /usr/local/bin/better-ccflare "${DOWNLOAD_URL}" || (echo "Failed to download binary from ${DOWNLOAD_URL}"; exit 1) && \
    chmod +x /usr/local/bin/better-ccflare && \
    echo "Binary downloaded successfully" && \
    file /usr/local/bin/better-ccflare && \
    # Versioned downloads must prove that the fetched tombii release is the
    # requested release, while latest/manual builds intentionally stay unproven.
    if [ "${VERSION}" = "latest" ]; then \
      /usr/local/bin/better-ccflare --version || (echo "Binary verification failed - exec format error"; exit 1); \
    else \
      expected_version="better-ccflare v${VERSION}"; \
      [ "${IMAGE_SHA}" != "unknown" ] && printf '%s\n' "${IMAGE_SHA}" | grep -Eq '^[0-9a-f]{40}$' || (echo "Versioned download requires a full checked-out release SHA"; exit 1); \
      reported_version="$(/usr/local/bin/better-ccflare --version)" || (echo "Binary verification failed - exec format error"; exit 1); \
      [ "${reported_version}" = "${expected_version}" ] || (echo "Downloaded binary version ${reported_version} does not match ${expected_version}"; exit 1); \
      reported_sha="$(/usr/local/bin/better-ccflare --git-sha)" || (echo "Binary SHA verification failed"; exit 1); \
      [ "${reported_sha}" = "${IMAGE_SHA}" ] || (echo "Downloaded binary SHA ${reported_sha} does not match ${IMAGE_SHA}"; exit 1); \
    fi && \
    echo "==================================="

# Create a non-root user to run the application
RUN useradd -r -u 1000 -m -s /bin/bash ccflare && \
    mkdir -p /data && \
    chown -R ccflare:ccflare /data /app

# Build provenance for the /health endpoint (packages/http-api/src/handlers/health.ts)
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG CHECKOUT_SHA=unknown
ARG EVENT_SHA=unknown
ARG TAG_SHA=unknown
ARG DISTRIBUTION=unknown
ARG PRODUCER=unknown
ARG ARTIFACT_MODE=unknown
ARG UPDATE_CHANNEL=unknown
ARG BUILD_DATE=unknown

# Set environment variables
ENV NODE_ENV=production
ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db
ENV XDG_CONFIG_HOME=/data
ENV BETTER_CCFLARE_LOG_DIR=/app/logs
ENV CCFLARE_VERSION=${VERSION}
ENV CCFLARE_GIT_SHA=${GIT_SHA}
ENV CCFLARE_GIT_REF=${GIT_REF}
# These duplicate immutable args let the runtime reject a stale or conflicting
# provenance tuple rather than inferring identity from the Docker environment.
ENV CCFLARE_SOURCE_SHA=${GIT_SHA}
ENV CCFLARE_SOURCE_REF=${GIT_REF}
ENV CCFLARE_CHECKOUT_SHA=${CHECKOUT_SHA}
ENV CCFLARE_EVENT_SHA=${EVENT_SHA}
ENV CCFLARE_TAG_SHA=${TAG_SHA}
ENV CCFLARE_BUILD_DATE=${BUILD_DATE}
ENV CCFLARE_DISTRIBUTION=${DISTRIBUTION}
ENV CCFLARE_PRODUCER=${PRODUCER}
ENV CCFLARE_ARTIFACT_MODE=${ARTIFACT_MODE}
ENV CCFLARE_UPDATE_CHANNEL=${UPDATE_CHANNEL}

# Create logs directory with proper permissions
RUN mkdir -p /app/logs /data && chown -R ccflare:ccflare /app/logs /data

# Expose default port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Add labels for version tracking (will be overridden by GitHub Actions metadata)
ARG VERSION
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.title="better-ccflare"
LABEL org.opencontainers.image.description="Load balancer proxy for Claude API with intelligent distribution across multiple OAuth accounts"
LABEL org.opencontainers.image.source="https://github.com/tombii/better-ccflare"

# Create startup script that shows version
RUN echo '#!/bin/bash\n\
echo "================================="\n\
echo "better-ccflare Docker Container"\n\
echo "================================="\n\
echo "Architecture: $(uname -m)"\n\
echo ""\n\
/usr/local/bin/better-ccflare --version\n\
echo "================================="\n\
echo ""\n\
exec /usr/local/bin/better-ccflare "$@"\n\
' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

# Switch to non-root user
USER ccflare

# Add volume mount for persistent data only
VOLUME ["/data"]

# Use the startup script as entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--serve", "--port", "8080"]
