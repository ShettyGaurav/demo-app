FROM registry.access.redhat.com/ubi8/python-39:latest AS builder

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

FROM registry.access.redhat.com/ubi8/python-39:latest

COPY --from=builder /opt/app-root/lib /opt/app-root/lib

COPY worker.py .

RUN mkdir -p /opt/app-root/src/data && \
    chgrp -R 0 /opt/app-root/src/data && \
    chmod -R g=u /opt/app-root/src/data

USER 1001

CMD ["python", "worker.py"]
