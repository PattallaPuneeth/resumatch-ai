import logging
import signal
import sys
import time
from types import FrameType

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("resumatch-ml-worker")

_running = True


def handle_shutdown(signum: int, frame: FrameType | None) -> None:
    global _running
    logger.info("Received termination signal %s. Shutting down worker gracefully...", signum)
    _running = False


def main() -> None:
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    logger.info("ResuMatch AI ML Worker initialized (Phase 2A baseline). Ready for jobs.")
    while _running:
        time.sleep(2)

    logger.info("ML Worker shutdown complete.")
    sys.exit(0)


if __name__ == "__main__":
    main()
