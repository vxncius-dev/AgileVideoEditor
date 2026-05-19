import json
import subprocess
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


class FFmpegHandler:
    def __init__(self, ffmpeg_bin="ffmpeg", ffprobe_bin="ffprobe"):
        self.ffmpeg_bin = ffmpeg_bin
        self.ffprobe_bin = ffprobe_bin

    def _run(self, command):
        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if process.returncode != 0:
            raise FFmpegError(process.stderr.strip() or "FFmpeg failed")
        return process

    def probe(self, input_file):
        command = [
            self.ffprobe_bin,
            "-v", "error",
            "-show_format",
            "-show_streams",
            "-of", "json",
            str(input_file)
        ]
        return json.loads(self._run(command).stdout)

    def thumbnail(self, input_file, output_file, at_seconds=1.0, width=320):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        command = [
            self.ffmpeg_bin,
            "-y",
            "-ss", str(at_seconds),
            "-i", str(input_file),
            "-frames:v", "1",
            "-vf", f"scale={width}:-1",
            str(output_file)
        ]
        self._run(command)
        return str(output_file)

    def waveform(self, input_file, output_file, width=1000, height=160):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        command = [
            self.ffmpeg_bin,
            "-y",
            "-i", str(input_file),
            "-filter_complex",
            f"aformat=channel_layouts=mono,showwavespic=s={width}x{height}:colors=4f9cff",
            "-frames:v", "1",
            str(output_file)
        ]
        self._run(command)
        return str(output_file)

    def transcode_preview(self, input_file, output_file, width=960):
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        command = [
            self.ffmpeg_bin,
            "-y",
            "-i", str(input_file),
            "-vf", f"scale='min({width},iw)':-2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "26",
            "-c:a", "aac",
            "-b:a", "128k",
            str(output_file)
        ]
        self._run(command)
        return str(output_file)

    def export_timeline(self, timeline, output_file):
        clips = self._flatten_video_clips(timeline)
        if not clips:
            raise FFmpegError("Timeline sem clipes de video para exportar")

        Path(output_file).parent.mkdir(parents=True, exist_ok=True)

        if len(clips) == 1:
            clip = clips[0]
            command = [
                self.ffmpeg_bin,
                "-y",
                "-ss", str(clip.get("sourceStart", 0)),
                "-t", str(max(0.01, clip.get("duration", 0))),
                "-i", clip["src"],
                "-c:v", "libx264",
                "-preset", "fast",
                "-c:a", "aac",
                str(output_file)
            ]
            self._run(command)
            return str(output_file)

        list_file = Path(output_file).with_suffix(".concat.txt")
        segment_paths = []
        try:
            for index, clip in enumerate(clips):
                segment = Path(output_file).with_suffix(f".part{index}.mp4")
                segment_paths.append(segment)
                command = [
                    self.ffmpeg_bin,
                    "-y",
                    "-ss", str(clip.get("sourceStart", 0)),
                    "-t", str(max(0.01, clip.get("duration", 0))),
                    "-i", clip["src"],
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-c:a", "aac",
                    str(segment)
                ]
                self._run(command)

            list_file.write_text(
                "\n".join(f"file '{path.as_posix()}'" for path in segment_paths),
                encoding="utf-8"
            )
            command = [
                self.ffmpeg_bin,
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", str(list_file),
                "-c", "copy",
                str(output_file)
            ]
            self._run(command)
            return str(output_file)
        finally:
            if list_file.exists():
                list_file.unlink()
            for path in segment_paths:
                if path.exists():
                    path.unlink()

    def _flatten_video_clips(self, timeline):
        clips = []
        for track in timeline.get("tracks", []):
            if track.get("type", "visual") not in ("visual", "video", "av"):
                continue
            for clip in track.get("clips", []):
                if clip.get("src") and clip.get("kind", "video") in ("video", "gif", "image"):
                    clips.append(clip)
        return sorted(clips, key=lambda clip: clip.get("start", 0))
