import json
import shutil
import sqlite3
import uuid
from pathlib import Path
from time import time


DEFAULT_TIMELINE = {
    "schema": 2,
    "fps": 60,
    "duration": 0,
    "size": {"width": 1920, "height": 1080},
    "tracks": [
        {"id": "v1", "name": "Video 1", "type": "visual", "clips": []},
        {"id": "v2", "name": "Overlay", "type": "visual", "clips": []},
        {"id": "a1", "name": "Audio 1", "type": "audio", "clips": []}
    ],
    "selection": [],
    "preview": {
        "time": 0,
        "playing": False,
        "zoom": 1,
        "stageScale": 1,
        "showUi": True
    }
}


class ProjectManager:
    def __init__(self, base_dir="./projects", db_path="app.db"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(exist_ok=True)
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.create_tables()

    def create_tables(self):
        cursor = self.db.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                last_opened_at INTEGER,
                thumbnail TEXT,
                project_path TEXT
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                name TEXT,
                type TEXT,
                path TEXT,
                thumbnail TEXT,
                waveform TEXT,
                metadata TEXT,
                created_at INTEGER
            )
        """)
        self.db.commit()

    def create_project(self, name):
        project_id = str(uuid.uuid4())
        project_dir = self.base_dir / project_id
        self._ensure_project_dirs(project_dir)
        self._write_json(project_dir / "timeline.json", DEFAULT_TIMELINE)

        now = int(time())
        self.db.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, name, now, now, now, "", str(project_dir))
        )
        self.db.commit()
        return self.get_project(project_id)

    def list_projects(self):
        rows = self.db.execute("""
            SELECT id, name, created_at, updated_at, last_opened_at, thumbnail
            FROM projects
            ORDER BY last_opened_at DESC
        """).fetchall()
        return [
            {
                "id": row[0],
                "name": row[1],
                "created_at": row[2],
                "updated_at": row[3],
                "last_opened_at": row[4],
                "thumbnail": row[5],
                "latest": index == 0
            }
            for index, row in enumerate(rows)
        ]

    def get_project(self, project_id):
        row = self.db.execute("""
            SELECT id, name, created_at, updated_at, last_opened_at, thumbnail, project_path
            FROM projects
            WHERE id=?
        """, (project_id,)).fetchone()
        if not row:
            return None

        project_path = Path(row[6])
        self._ensure_project_dirs(project_path)
        self.touch(project_id)
        return {
            "id": row[0],
            "name": row[1],
            "created_at": row[2],
            "updated_at": row[3],
            "last_opened_at": int(time()),
            "thumbnail": row[5],
            "project_path": str(project_path),
            "timeline": self.load_timeline(project_id),
            "assets": self.list_assets(project_id),
            "autosave": self.load_autosave(project_id)
        }

    def load_timeline(self, project_id):
        project_path = self.get_project_path(project_id)
        if not project_path:
            return None
        timeline_file = project_path / "timeline.json"
        if not timeline_file.exists():
            self._write_json(timeline_file, DEFAULT_TIMELINE)
        timeline = self._read_json(timeline_file)
        return self.normalize_timeline(timeline)

    def save_timeline(self, project_id, data):
        project_path = self.get_project_path(project_id)
        if not project_path:
            return False
        self._write_json(project_path / "timeline.json", self.normalize_timeline(data))
        self.touch(project_id, update=True)
        return True

    def normalize_timeline(self, timeline):
        data = dict(DEFAULT_TIMELINE)
        data.update(timeline or {})
        data["schema"] = 2
        data.setdefault("size", {"width": 1920, "height": 1080})
        data.setdefault("selection", [])
        data.setdefault("preview", {}).update({
            key: value
            for key, value in DEFAULT_TIMELINE["preview"].items()
            if key not in data.get("preview", {})
        })

        tracks = data.get("tracks") or DEFAULT_TIMELINE["tracks"]
        normalized_tracks = []
        for track in tracks:
            next_track = {
                "id": track.get("id") or str(uuid.uuid4()),
                "name": track.get("name") or "Track",
                "type": "visual" if track.get("type") == "video" else track.get("type", "visual"),
                "clips": []
            }
            for clip in track.get("clips", []):
                next_track["clips"].append(self.normalize_clip(clip, next_track["type"]))
            normalized_tracks.append(next_track)
        while len([track for track in normalized_tracks if track["type"] == "visual"]) < 2:
            normalized_tracks.append({
                "id": str(uuid.uuid4()),
                "name": "Overlay",
                "type": "visual",
                "clips": []
            })
        if not any(track["type"] == "audio" for track in normalized_tracks):
            normalized_tracks.append({
                "id": str(uuid.uuid4()),
                "name": "Audio 1",
                "type": "audio",
                "clips": []
            })
        data["tracks"] = normalized_tracks
        data["duration"] = max(
            [0] + [
                clip["start"] + clip["duration"]
                for track in normalized_tracks
                for clip in track["clips"]
            ]
        )
        return data

    def normalize_clip(self, clip, track_type):
        clip_type = clip.get("kind") or clip.get("type") or ("audio" if track_type == "audio" else "video")
        return {
            "id": clip.get("id") or str(uuid.uuid4()),
            "assetId": clip.get("assetId"),
            "kind": clip_type,
            "name": clip.get("name") or clip_type.title(),
            "src": clip.get("src", ""),
            "start": float(clip.get("start", 0)),
            "duration": float(clip.get("duration", 5)),
            "zIndex": int(clip.get("zIndex", 1)),
            "locked": bool(clip.get("locked", False)),
            "visible": clip.get("visible", True),
            "opacity": float(clip.get("opacity", 1)),
            "blendMode": clip.get("blendMode", "normal"),
            "speed": float(clip.get("speed", 1)),
            "trim": clip.get("trim", {"in": clip.get("sourceStart", 0), "out": None}),
            "transform": clip.get("transform", {
                "x": 0,
                "y": 0,
                "width": 640,
                "height": 360,
                "scaleX": 1,
                "scaleY": 1,
                "rotation": 0,
                "anchor": "center"
            }),
            "crop": clip.get("crop", {"x": 0, "y": 0, "width": 1, "height": 1, "unit": "percent"}),
            "text": clip.get("text", ""),
            "style": clip.get("style", {
                "fontFamily": "Arial",
                "fontSize": 64,
                "fontWeight": "700",
                "fontStyle": "normal",
                "color": "#ffffff",
                "align": "center",
                "lineHeight": 1.15,
                "strokeColor": "#000000",
                "strokeWidth": 0,
                "background": "transparent"
            }),
            "audio": clip.get("audio", {
                "volume": 1,
                "fadeIn": 0,
                "fadeOut": 0,
                "muted": False
            }),
            "filters": clip.get("filters", [])
        }

    def save_autosave(self, project_id, data):
        project_path = self.get_project_path(project_id)
        if not project_path:
            return False
        payload = {
            "saved_at": int(time()),
            "timeline": data
        }
        self._write_json(project_path / "autosave.json", payload)
        return payload

    def load_autosave(self, project_id):
        project_path = self.get_project_path(project_id)
        if not project_path:
            return None
        path = project_path / "autosave.json"
        return self._read_json(path) if path.exists() else None

    def restore_autosave(self, project_id):
        autosave = self.load_autosave(project_id)
        if not autosave:
            return None
        self.save_timeline(project_id, autosave["timeline"])
        return autosave["timeline"]

    def add_asset(self, project_id, source_path, metadata=None):
        project_path = self.get_project_path(project_id)
        if not project_path:
            return None

        source = Path(source_path)
        if not source.exists():
            raise FileNotFoundError(str(source))

        asset_id = str(uuid.uuid4())
        target = project_path / "assets" / f"{asset_id}{source.suffix.lower()}"
        shutil.copy2(source, target)

        asset_type = self._asset_type(source.suffix.lower())
        now = int(time())
        self.db.execute("""
            INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            asset_id,
            project_id,
            source.name,
            asset_type,
            str(target),
            "",
            "",
            json.dumps(metadata or {}),
            now
        ))
        self.db.commit()
        return self.get_asset(asset_id)

    def update_asset_media(self, asset_id, thumbnail=None, waveform=None, metadata=None):
        asset = self.get_asset(asset_id)
        if not asset:
            return None
        next_metadata = asset["metadata"]
        if metadata:
            next_metadata.update(metadata)
        self.db.execute("""
            UPDATE assets
            SET thumbnail=?, waveform=?, metadata=?
            WHERE id=?
        """, (
            thumbnail if thumbnail is not None else asset["thumbnail"],
            waveform if waveform is not None else asset["waveform"],
            json.dumps(next_metadata),
            asset_id
        ))
        self.db.commit()
        return self.get_asset(asset_id)

    def get_asset(self, asset_id):
        row = self.db.execute("""
            SELECT id, project_id, name, type, path, thumbnail, waveform, metadata, created_at
            FROM assets
            WHERE id=?
        """, (asset_id,)).fetchone()
        return self._asset_from_row(row) if row else None

    def list_assets(self, project_id):
        rows = self.db.execute("""
            SELECT id, project_id, name, type, path, thumbnail, waveform, metadata, created_at
            FROM assets
            WHERE project_id=?
            ORDER BY created_at DESC
        """, (project_id,)).fetchall()
        return [self._asset_from_row(row) for row in rows]

    def get_project_path(self, project_id):
        row = self.db.execute(
            "SELECT project_path FROM projects WHERE id=?",
            (project_id,)
        ).fetchone()
        return Path(row[0]) if row else None

    def touch(self, project_id, update=False):
        now = int(time())
        if update:
            self.db.execute("""
                UPDATE projects
                SET updated_at=?, last_opened_at=?
                WHERE id=?
            """, (now, now, project_id))
        else:
            self.db.execute(
                "UPDATE projects SET last_opened_at=? WHERE id=?",
                (now, project_id)
            )
        self.db.commit()

    def _asset_from_row(self, row):
        return {
            "id": row[0],
            "project_id": row[1],
            "name": row[2],
            "type": row[3],
            "path": row[4],
            "thumbnail": row[5],
            "waveform": row[6],
            "metadata": json.loads(row[7] or "{}"),
            "created_at": row[8]
        }

    def _asset_type(self, suffix):
        if suffix in (".mp4", ".mov", ".mkv", ".avi", ".webm"):
            return "video"
        if suffix in (".mp3", ".wav", ".aac", ".flac", ".ogg"):
            return "audio"
        if suffix in (".png", ".jpg", ".jpeg", ".webp"):
            return "image"
        return "file"

    def _ensure_project_dirs(self, project_dir):
        project_dir.mkdir(parents=True, exist_ok=True)
        for name in ("assets", "cache", "exports", "thumbnails", "waveforms"):
            (project_dir / name).mkdir(exist_ok=True)

    def _read_json(self, path):
        with open(path, encoding="utf-8") as file:
            return json.load(file)

    def _write_json(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2, ensure_ascii=False)
