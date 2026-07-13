# Build stage: compile static Go binary on full UBI 9
FROM registry.access.redhat.com/ubi9/ubi AS builder

RUN dnf install -y golang && dnf clean all

WORKDIR /build
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o health-aggregator .

# Runtime stage: minimal UBI 9 image (~40MB)
FROM registry.access.redhat.com/ubi9/ubi-minimal

LABEL maintainer="app3-practice" \
      description="Health aggregator for Smart Task Processing System" \
      io.k8s.display-name="Health Aggregator"

RUN microdnf install -y ca-certificates && \
    microdnf clean all && \
    mkdir -p /opt/app-root/src && \
    chgrp -R 0 /opt/app-root && \
    chmod -R g=u /opt/app-root

COPY --from=builder /build/health-aggregator /usr/local/bin/health-aggregator

USER 1001

EXPOSE 3003

CMD ["/usr/local/bin/health-aggregator"]
