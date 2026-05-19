from pathlib import Path
import os
import sys

from filelock import FileLock, Timeout
from webview import create_window, start

from backend.api import Api


class UIConfig:
    def __init__(self):
        self.api = Api()
        self.app_name = "Agile Video Editor"
        self.root_dir = Path(__file__).resolve().parent
        self.home_source = str(self.root_dir / "frontend" / "index.html")
        self.storage_path = self.build_storage_path()
        self.window_width = 1180
        self.window_height = 760

    def build_storage_path(self):
        base_dir = Path(os.environ.get("LOCALAPPDATA", self.root_dir))
        storage_path = base_dir / "AgileVideoEditor" / "webview-data"
        storage_path.mkdir(parents=True, exist_ok=True)
        return str(storage_path)

    def build_window(self):
        return create_window(
            self.app_name,
            self.home_source,
            width=self.window_width,
            height=self.window_height,
            js_api=self.api
        )


class AgileVideoEditor(UIConfig):
    def __init__(self):
        super().__init__()
        self.window = self.build_window()

    def run(self):
        start(
            debug=True,
            private_mode=False,
            storage_path=self.storage_path
        )


def main():
    lock = FileLock("app.lock")
    try:
        lock.acquire(timeout=0)
    except Timeout:
        print("Aplicacao ja aberta")
        sys.exit(0)

    try:
        AgileVideoEditor().run()
    finally:
        lock.release()


if __name__ == "__main__":
    main()
