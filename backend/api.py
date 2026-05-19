from pathlib import Path
from time import time

from backend.ffmpeg_handler import FFmpegError, FFmpegHandler
from backend.project_manager import ProjectManager


class Api:
    def __init__(self):
        self._projects = ProjectManager()
        self._ffmpeg = FFmpegHandler()

    def health(self):
        return {"status": 200, "time": int(time())}

    def list_projects(self):
        projects = self._projects.list_projects()
        if not projects:
            self._projects.create_project("Novo projeto")
            projects = self._projects.list_projects()
        return projects

    def create_project(self, name="Novo projeto"):
        return self._projects.create_project(name)

    def get_project(self, project_id):
        return self._projects.get_project(str(project_id))

    def load_timeline(self, project_id):
        return self._projects.load_timeline(str(project_id))

    def save_timeline(self, project_id, timeline):
        return {"ok": self._projects.save_timeline(str(project_id), timeline)}

    def autosave_timeline(self, project_id, timeline):
        autosave = self._projects.save_autosave(str(project_id), timeline)
        return {"ok": bool(autosave), "autosave": autosave}

    def restore_autosave(self, project_id):
        timeline = self._projects.restore_autosave(str(project_id))
        return {"ok": bool(timeline), "timeline": timeline}

    def import_asset(self, project_id, source_path):
        asset = self._projects.add_asset(str(project_id), source_path)
        if not asset:
            return {"ok": False, "error": "Projeto nao encontrado"}

        project_path = self._projects.get_project_path(str(project_id))
        thumb = project_path / "thumbnails" / f"{asset['id']}.jpg"
        wave = project_path / "waveforms" / f"{asset['id']}.png"
        metadata = {}

        try:
            metadata = self._ffmpeg.probe(asset["path"])
            thumbnail = ""
            waveform = ""
            if asset["type"] in ("video", "image"):
                thumbnail = self._ffmpeg.thumbnail(asset["path"], thumb)
            if asset["type"] in ("video", "audio"):
                waveform = self._ffmpeg.waveform(asset["path"], wave)
            asset = self._projects.update_asset_media(
                asset["id"],
                thumbnail=thumbnail,
                waveform=waveform,
                metadata=metadata
            )
        except (FFmpegError, FileNotFoundError) as error:
            asset = self._projects.update_asset_media(
                asset["id"],
                metadata={"ffmpeg_error": str(error)}
            )

        return {"ok": True, "asset": asset}

    def list_assets(self, project_id):
        return self._projects.list_assets(str(project_id))

    def export_project(self, project_id, output_path=None):
        project_id = str(project_id)
        project_path = self._projects.get_project_path(project_id)
        if not project_path:
            return {"ok": False, "error": "Projeto nao encontrado"}

        timeline = self._projects.load_timeline(project_id)
        output = Path(output_path) if output_path else project_path / "exports" / "export.mp4"
        try:
            result = self._ffmpeg.export_timeline(timeline, output)
            return {"ok": True, "path": result}
        except FFmpegError as error:
            return {"ok": False, "error": str(error)}
