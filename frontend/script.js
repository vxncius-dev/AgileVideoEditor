const uid = () => crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

class Config {
    constructor() {
        this.config = {
            name: "Agile Video Editor",
            version: "0.4.0",
            type: "Desktop Tool"
        };
    }

    async waitPywebview() {
        if (window.pywebview?.api) return true;
        return new Promise(resolve => {
            window.addEventListener("pywebviewready", () => resolve(true), { once: true });
        });
    }

    setAppName() {
        document.querySelectorAll(".name").forEach(item => {
            item.textContent = this.config.name;
        });
    }

    async api(method, ...args) {
        await this.waitPywebview();
        if (!window.pywebview?.api?.[method]) throw new Error(`API "${method}" nao encontrada`);
        return await window.pywebview.api[method](...args);
    }
}

class AgileApp extends Config {
    constructor() {
        super();
        this.projectList = document.getElementById("projectList");
        this.newProject = document.getElementById("newProject");
        this.init();
    }

    async init() {
        await this.waitPywebview();
        this.setAppName();
        await this.loadProjects();
        this.registerEvents();
    }

    async loadProjects() {
        if (!this.projectList) return;
        const projects = await this.api("list_projects");
        this.projectList.innerHTML = "";
        projects.forEach(item => {
            const li = document.createElement("li");
            li.innerHTML = `
                <a href="editor.html?projectId=${item.id}" class="${item.latest ? "latest" : ""}" data-id="${item.id}">
                    <strong>${item.name}</strong>
                    <span>${new Date(item.updated_at * 1000).toLocaleString()}</span>
                </a>`;
            this.projectList.appendChild(li);
        });
    }

    registerEvents() {
        this.newProject?.addEventListener("click", async () => {
            const project = await this.api("create_project", "Novo projeto");
            sessionStorage.setItem("currentProject", JSON.stringify(project));
            window.location.href = `editor.html?projectId=${project.id}`;
        });

        document.addEventListener("click", event => {
            const project = event.target.closest("a[data-id]");
            if (!project) return;
            event.preventDefault();
            window.location.href = `editor.html?projectId=${project.dataset.id}`;
        });
    }
}

class Editor extends Config {
    constructor() {
        super();
        this.project = null;
        this.timeline = null;
        this.assets = [];
        this.selected = new Set();
        this.clipboard = [];
        this.undoStack = [];
        this.redoStack = [];
        this.dragging = null;
        this.dirty = false;
        this.refs = {
            root: document.querySelector(".player-editor"),
            title: document.getElementById("projectTitle"),
            status: document.getElementById("saveStatus"),
            preview: document.getElementById("preview"),
            stage: document.getElementById("stage"),
            timeline: document.getElementById("timeline"),
            timelineDock: document.getElementById("timelineDock"),
            ruler: document.getElementById("timelineRuler"),
            play: document.getElementById("play"),
            save: document.getElementById("save"),
            export: document.getElementById("export"),
            addText: document.getElementById("addText"),
            addImage: document.getElementById("addImage"),
            addVideo: document.getElementById("addVideo"),
            addAudio: document.getElementById("addAudio"),
            toggleTimeline: document.getElementById("toggleTimeline"),
            zoomIn: document.getElementById("zoomIn"),
            zoomOut: document.getElementById("zoomOut"),
            assetPath: document.getElementById("assetPath"),
            importAsset: document.getElementById("importAsset"),
            timecode: document.getElementById("timecode"),
            inspector: document.getElementById("inspector"),
            inspectorTitle: document.getElementById("inspectorTitle"),
            inspectorFields: document.getElementById("inspectorFields"),
            promptText: document.getElementById("promptText")
        };
        this.init();
    }

    async init() {
        await this.waitPywebview();
        this.setAppName();
        const id = new URLSearchParams(window.location.search).get("projectId");
        if (!id) return this.setStatus("Projeto nao encontrado");

        this.project = await this.api("get_project", id);
        this.timeline = this.project.autosave?.saved_at > this.project.updated_at
            ? this.project.autosave.timeline
            : this.project.timeline;
        this.assets = this.project.assets || [];
        this.normalizeTimeline();

        this.refs.title.textContent = this.project.name;
        if (this.refs.promptText) this.refs.promptText.value = this.timeline.prompt || "";
        this.registerEvents();
        this.render();
        this.startAutosave();
    }

    normalizeTimeline() {
        this.timeline.schema = 2;
        this.timeline.size ||= { width: 1920, height: 1080 };
        this.timeline.selection ||= [];
        this.timeline.preview ||= { time: 0, playing: false, zoom: 1, stageScale: 1, showUi: true };
        this.timeline.tracks ||= [
            { id: "v1", name: "Video 1", type: "visual", clips: [] },
            { id: "v2", name: "Overlay", type: "visual", clips: [] },
            { id: "a1", name: "Audio 1", type: "audio", clips: [] }
        ];
    }

    registerEvents() {
        this.refs.play.addEventListener("click", () => this.togglePlayback());
        this.refs.save.addEventListener("click", () => this.saveTimeline());
        this.refs.export.addEventListener("click", () => this.exportProject());
        this.refs.importAsset.addEventListener("click", () => this.importAsset());
        this.refs.addText.addEventListener("click", () => this.addText());
        this.refs.addImage.addEventListener("click", () => this.addLastAsset("image"));
        this.refs.addVideo.addEventListener("click", () => this.addLastAsset("video"));
        this.refs.addAudio.addEventListener("click", () => this.addLastAsset("audio"));
        this.refs.toggleTimeline.addEventListener("click", () => this.refs.timelineDock.classList.toggle("hidden"));
        this.refs.zoomIn.addEventListener("click", () => this.setZoom(this.timeline.preview.zoom + 0.15));
        this.refs.zoomOut.addEventListener("click", () => this.setZoom(this.timeline.preview.zoom - 0.15));
        this.refs.promptText?.addEventListener("input", () => {
            this.timeline.prompt = this.refs.promptText.value;
            this.markDirty();
        });

        this.refs.stage.addEventListener("pointerdown", event => this.startStageDrag(event));
        this.refs.timeline.addEventListener("pointerdown", event => this.startTimelineDrag(event));
        window.addEventListener("pointermove", event => this.moveDrag(event));
        window.addEventListener("pointerup", () => this.endDrag());

        document.addEventListener("keydown", event => this.handleHotkeys(event));
        window.addEventListener("beforeunload", () => {
            if (this.dirty) this.autosave();
        });
    }

    handleHotkeys(event) {
        const key = event.key.toLowerCase();
        const mod = event.ctrlKey || event.metaKey;
        if (!mod && event.code === "Space") {
            event.preventDefault();
            return this.togglePlayback();
        }
        if (!mod && ["Delete", "Backspace"].includes(event.key)) {
            event.preventDefault();
            return this.deleteSelection();
        }
        if (!mod && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            return this.nudgeSelection(event.key, event.shiftKey ? 10 : 1);
        }
        if (!mod) return;
        if (key === "s") return this.prevent(event, () => this.saveTimeline());
        if (key === "e") return this.prevent(event, () => this.exportProject());
        if (key === "a") return this.prevent(event, () => this.selectAll());
        if (key === "c") return this.prevent(event, () => this.copySelection(false));
        if (key === "x") return this.prevent(event, () => this.copySelection(true));
        if (key === "v") return this.prevent(event, () => this.pasteSelection());
        if (key === "z") return this.prevent(event, () => this.undo());
        if (key === "r" || (event.shiftKey && key === "z")) return this.prevent(event, () => this.redo());
    }

    prevent(event, action) {
        event.preventDefault();
        action();
    }

    render() {
        this.renderStage();
        this.renderTimeline();
        this.renderInspector();
        this.updatePlaybackUi();
    }

    renderStage() {
        this.refs.stage.innerHTML = "";
        const activeClips = this.visualClips()
            .filter(clip => clip.visible !== false && this.clipAtTime(clip, this.timeline.preview.time))
            .sort((a, b) => a.zIndex - b.zIndex);

        for (const clip of activeClips) {
            const node = document.createElement("div");
            node.className = `stage-item ${clip.kind} ${this.selected.has(clip.id) ? "selected" : ""}`;
            node.dataset.clipId = clip.id;
            this.applyStageGeometry(node, clip);

            if (clip.kind === "text") {
                node.textContent = clip.text || "Texto";
                this.applyTextStyle(node, clip);
            } else if (clip.kind === "image" || clip.kind === "gif") {
                node.innerHTML = `<img src="${this.pathToUrl(clip.src)}" alt="">`;
            } else if (clip.kind === "video") {
                node.innerHTML = `<video src="${this.pathToUrl(clip.src)}" muted></video>`;
            }
            this.refs.stage.appendChild(node);
        }
    }

    renderTimeline() {
        const px = this.pxPerSecond();
        this.refs.ruler.innerHTML = "";
        this.refs.timeline.innerHTML = "";
        for (let second = 0; second <= Math.max(60, this.timeline.duration); second += 5) {
            const tick = document.createElement("span");
            tick.style.left = `${second * px}px`;
            tick.textContent = `${second}s`;
            this.refs.ruler.appendChild(tick);
        }

        for (const track of this.timeline.tracks) {
            const row = document.createElement("div");
            row.className = `timeline-track ${track.type}`;
            row.dataset.trackId = track.id;
            row.innerHTML = `<label>${track.name}</label>`;
            for (const clip of track.clips) {
                const el = document.createElement("button");
                el.type = "button";
                el.className = `timeline-clip ${clip.kind} ${this.selected.has(clip.id) ? "selected" : ""}`;
                el.dataset.clipId = clip.id;
                el.style.left = `${clip.start * px}px`;
                el.style.width = `${Math.max(46, clip.duration * px)}px`;
                el.innerHTML = this.timelineClipPreview(clip);
                row.appendChild(el);
            }
            this.refs.timeline.appendChild(row);
        }
    }

    renderInspector() {
        const clip = this.focusedClip();
        this.refs.inspector.classList.toggle("open", Boolean(clip));
        if (!clip) {
            this.refs.inspectorTitle.textContent = "Sem seleção";
            this.refs.inspectorFields.innerHTML = "";
            return;
        }
        this.refs.inspectorTitle.textContent = clip.name;
        const groups = [
            this.numberField("X", clip.transform.x, value => clip.transform.x = value),
            this.numberField("Y", clip.transform.y, value => clip.transform.y = value),
            this.numberField("W", clip.transform.width, value => clip.transform.width = value),
            this.numberField("H", clip.transform.height, value => clip.transform.height = value),
            this.numberField("Rotacao", clip.transform.rotation, value => clip.transform.rotation = value),
            this.numberField("Opacidade", clip.opacity, value => clip.opacity = value, 0.05),
            this.numberField("Velocidade", clip.speed, value => clip.speed = value, 0.05)
        ];

        if (clip.kind === "text") {
            groups.push(
                this.textField("Texto", clip.text, value => clip.text = value),
                this.numberField("Fonte", clip.style.fontSize, value => clip.style.fontSize = value),
                this.colorField("Cor", clip.style.color, value => clip.style.color = value),
                this.selectField("Alinhar", clip.style.align, ["left", "center", "right"], value => clip.style.align = value),
                this.selectField("Peso", clip.style.fontWeight, ["400", "700", "900"], value => clip.style.fontWeight = value)
            );
        }

        if (clip.kind === "audio") {
            groups.push(
                this.numberField("Volume", clip.audio.volume, value => clip.audio.volume = value, 0.05),
                this.numberField("Fade in", clip.audio.fadeIn, value => clip.audio.fadeIn = value, 0.1),
                this.numberField("Fade out", clip.audio.fadeOut, value => clip.audio.fadeOut = value, 0.1)
            );
        }

        this.refs.inspectorFields.replaceChildren(...groups);
    }

    numberField(label, value, setter, step = 1) {
        return this.inputField(label, "number", value, setter, { step });
    }

    colorField(label, value, setter) {
        return this.inputField(label, "color", value, setter);
    }

    textField(label, value, setter) {
        return this.inputField(label, "text", value, setter);
    }

    selectField(label, value, options, setter) {
        const wrap = this.fieldWrap(label);
        const input = document.createElement("select");
        input.innerHTML = options.map(option => `<option value="${option}">${option}</option>`).join("");
        input.value = value;
        input.addEventListener("change", () => this.commitInspectorChange(() => setter(input.value)));
        wrap.appendChild(input);
        return wrap;
    }

    inputField(label, type, value, setter, attrs = {}) {
        const wrap = this.fieldWrap(label);
        const input = document.createElement("input");
        input.type = type;
        input.value = value;
        Object.assign(input, attrs);
        input.addEventListener("input", () => {
            const next = type === "number" ? Number(input.value) : input.value;
            this.commitInspectorChange(() => setter(next));
        });
        wrap.appendChild(input);
        return wrap;
    }

    fieldWrap(label) {
        const wrap = document.createElement("label");
        wrap.className = "field";
        wrap.append(label);
        return wrap;
    }

    commitInspectorChange(setter) {
        this.snapshot();
        setter();
        this.markDirty();
        this.render();
    }

    addText() {
        this.snapshot();
        const clip = this.newClip("text", {
            name: "Texto",
            text: "Texto",
            duration: 5,
            transform: { x: 640, y: 320, width: 640, height: 160, scaleX: 1, scaleY: 1, rotation: 0, anchor: "center" }
        });
        this.trackByType("visual").clips.push(clip);
        this.selectOnly(clip.id);
        this.markDirty();
        this.render();
    }

    addLastAsset(type) {
        const asset = this.assets.find(item => type === "image"
            ? ["image", "gif"].includes(item.type)
            : item.type === type);
        if (!asset) return this.setStatus(`Importe um asset de ${type}`);
        this.addAssetClip(asset);
    }

    addAssetClip(asset) {
        this.snapshot();
        const kind = asset.type === "audio" ? "audio" : asset.type === "image" ? "image" : "video";
        const duration = Number(asset.metadata?.format?.duration || 5);
        const clip = this.newClip(kind, {
            assetId: asset.id,
            name: asset.name,
            src: asset.path,
            duration,
            transform: { x: 520, y: 240, width: 720, height: 405, scaleX: 1, scaleY: 1, rotation: 0, anchor: "center" }
        });
        this.trackByType(kind === "audio" ? "audio" : "visual").clips.push(clip);
        this.selectOnly(clip.id);
        this.markDirty();
        this.render();
    }

    newClip(kind, values = {}) {
        return {
            id: uid(),
            assetId: null,
            kind,
            name: kind,
            src: "",
            start: this.timeline.preview.time || 0,
            duration: 5,
            zIndex: this.visualClips().length + 1,
            locked: false,
            visible: true,
            opacity: 1,
            blendMode: "normal",
            speed: 1,
            trim: { in: 0, out: null },
            transform: { x: 0, y: 0, width: 640, height: 360, scaleX: 1, scaleY: 1, rotation: 0, anchor: "center" },
            crop: { x: 0, y: 0, width: 1, height: 1, unit: "percent" },
            text: "",
            style: {
                fontFamily: "Arial",
                fontSize: 64,
                fontWeight: "700",
                fontStyle: "normal",
                color: "#ffffff",
                align: "center",
                lineHeight: 1.15,
                strokeColor: "#000000",
                strokeWidth: 0,
                background: "transparent"
            },
            audio: { volume: 1, fadeIn: 0, fadeOut: 0, muted: false },
            filters: [],
            ...values
        };
    }

    startStageDrag(event) {
        const node = event.target.closest(".stage-item");
        if (!node) {
            this.selected.clear();
            this.render();
            return;
        }
        this.selectClip(node.dataset.clipId, event.ctrlKey || event.metaKey);
        const clip = this.findClip(node.dataset.clipId);
        if (!clip || clip.locked) return;
        this.snapshot();
        this.dragging = {
            mode: "stage",
            clipId: clip.id,
            x: event.clientX,
            y: event.clientY,
            originX: clip.transform.x,
            originY: clip.transform.y
        };
        node.setPointerCapture?.(event.pointerId);
        this.render();
    }

    startTimelineDrag(event) {
        const node = event.target.closest(".timeline-clip");
        if (!node) return;
        this.selectClip(node.dataset.clipId, event.ctrlKey || event.metaKey);
        const clip = this.findClip(node.dataset.clipId);
        if (!clip || clip.locked) return;
        this.snapshot();
        this.dragging = {
            mode: "timeline",
            clipId: clip.id,
            x: event.clientX,
            originStart: clip.start
        };
        node.setPointerCapture?.(event.pointerId);
        this.render();
    }

    moveDrag(event) {
        if (!this.dragging) return;
        const clip = this.findClip(this.dragging.clipId);
        if (!clip) return;
        if (this.dragging.mode === "stage") {
            clip.transform.x = Math.round(this.dragging.originX + event.clientX - this.dragging.x);
            clip.transform.y = Math.round(this.dragging.originY + event.clientY - this.dragging.y);
        } else {
            clip.start = Math.max(0, Math.round((this.dragging.originStart + (event.clientX - this.dragging.x) / this.pxPerSecond()) * 100) / 100);
        }
        this.markDirty();
        this.render();
    }

    endDrag() {
        this.dragging = null;
    }

    selectClip(id, additive = false) {
        if (!additive) this.selected.clear();
        this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
        this.timeline.selection = [...this.selected];
    }

    selectOnly(id) {
        this.selected = new Set([id]);
        this.timeline.selection = [id];
    }

    selectAll() {
        this.selected = new Set(this.allClips().map(clip => clip.id));
        this.timeline.selection = [...this.selected];
        this.render();
    }

    copySelection(cut) {
        this.clipboard = this.allClips()
            .filter(clip => this.selected.has(clip.id))
            .map(clip => structuredClone(clip));
        if (cut) this.deleteSelection();
    }

    pasteSelection() {
        if (!this.clipboard.length) return;
        this.snapshot();
        this.selected.clear();
        for (const item of this.clipboard) {
            const clip = structuredClone(item);
            clip.id = uid();
            clip.start += 0.5;
            clip.transform.x += 24;
            clip.transform.y += 24;
            this.trackByKind(clip.kind).clips.push(clip);
            this.selected.add(clip.id);
        }
        this.timeline.selection = [...this.selected];
        this.markDirty();
        this.render();
    }

    deleteSelection() {
        if (!this.selected.size) return;
        this.snapshot();
        for (const track of this.timeline.tracks) {
            track.clips = track.clips.filter(clip => !this.selected.has(clip.id));
        }
        this.selected.clear();
        this.markDirty();
        this.render();
    }

    nudgeSelection(key, amount) {
        if (!this.selected.size) return;
        this.snapshot();
        const delta = {
            ArrowUp: [0, -amount],
            ArrowDown: [0, amount],
            ArrowLeft: [-amount, 0],
            ArrowRight: [amount, 0]
        }[key];
        for (const clip of this.allClips().filter(item => this.selected.has(item.id))) {
            clip.transform.x += delta[0];
            clip.transform.y += delta[1];
        }
        this.markDirty();
        this.render();
    }

    undo() {
        const state = this.undoStack.pop();
        if (!state) return;
        this.redoStack.push(structuredClone(this.timeline));
        this.timeline = state;
        this.selected = new Set(this.timeline.selection || []);
        this.markDirty();
        this.render();
    }

    redo() {
        const state = this.redoStack.pop();
        if (!state) return;
        this.undoStack.push(structuredClone(this.timeline));
        this.timeline = state;
        this.selected = new Set(this.timeline.selection || []);
        this.markDirty();
        this.render();
    }

    snapshot() {
        this.undoStack.push(structuredClone(this.timeline));
        this.redoStack = [];
        if (this.undoStack.length > 80) this.undoStack.shift();
    }

    togglePlayback() {
        this.timeline.preview.playing = !this.timeline.preview.playing;
        if (this.timeline.preview.playing) this.refs.preview.play?.();
        else this.refs.preview.pause?.();
        this.updatePlaybackUi();
        this.markDirty();
    }

    updatePlaybackUi() {
        this.refs.root.classList.toggle("playing", this.timeline.preview.playing);
        this.refs.play.textContent = this.timeline.preview.playing ? "Pause" : "Play";
        this.refs.timecode.textContent = `${this.timeline.preview.time.toFixed(2)}s`;
        const firstVideo = this.visualClips().find(clip => clip.kind === "video" && clip.src);
        if (firstVideo && this.refs.preview.src !== this.pathToUrl(firstVideo.src)) {
            this.refs.preview.src = this.pathToUrl(firstVideo.src);
        }
    }

    async importAsset() {
        const sourcePath = this.refs.assetPath.value.trim();
        if (!sourcePath) return this.setStatus("Informe o caminho do asset");
        this.setStatus("Importando...");
        const result = await this.api("import_asset", this.project.id, sourcePath);
        if (!result.ok) return this.setStatus(result.error || "Falha ao importar");
        this.assets.unshift(result.asset);
        this.refs.assetPath.value = "";
        this.addAssetClip(result.asset);
        this.setStatus("Asset importado");
    }

    async saveTimeline() {
        await this.api("save_timeline", this.project.id, this.timeline);
        this.dirty = false;
        this.setStatus("Salvo");
    }

    async autosave() {
        await this.api("autosave_timeline", this.project.id, this.timeline);
        this.setStatus("Autosave");
    }

    startAutosave() {
        setInterval(() => {
            if (this.dirty) this.autosave();
        }, 5000);
    }

    async exportProject() {
        this.setStatus("Exportando...");
        const result = await this.api("export_project", this.project.id);
        this.setStatus(result.ok ? `Exportado: ${result.path}` : result.error);
    }

    setZoom(value) {
        this.timeline.preview.zoom = Math.max(0.3, Math.min(4, value));
        this.markDirty();
        this.renderTimeline();
    }

    timelineClipPreview(clip) {
        if (clip.kind === "audio") return `<span>${clip.name}</span>`;
        if (clip.kind === "text") return `<span>${clip.text || clip.name}</span>`;
        const asset = this.assets.find(item => item.id === clip.assetId);
        const media = asset?.thumbnail || clip.src;
        return media ? `<img src="${this.pathToUrl(media)}" alt=""><span>${clip.name}</span>` : `<span>${clip.name}</span>`;
    }

    applyStageGeometry(node, clip) {
        const t = clip.transform;
        node.style.left = `${t.x}px`;
        node.style.top = `${t.y}px`;
        node.style.width = `${t.width}px`;
        node.style.height = `${t.height}px`;
        node.style.opacity = clip.opacity;
        node.style.zIndex = clip.zIndex;
        node.style.transform = `translate(-50%, -50%) rotate(${t.rotation}deg) scale(${t.scaleX}, ${t.scaleY})`;
    }

    applyTextStyle(node, clip) {
        const style = clip.style;
        node.style.color = style.color;
        node.style.fontFamily = style.fontFamily;
        node.style.fontSize = `${style.fontSize}px`;
        node.style.fontWeight = style.fontWeight;
        node.style.fontStyle = style.fontStyle;
        node.style.textAlign = style.align;
        node.style.lineHeight = style.lineHeight;
        node.style.webkitTextStroke = `${style.strokeWidth}px ${style.strokeColor}`;
        node.style.background = style.background;
    }

    trackByKind(kind) {
        return this.trackByType(kind === "audio" ? "audio" : "visual");
    }

    trackByType(type) {
        let track = this.timeline.tracks.find(item => item.type === type);
        if (!track) {
            track = { id: uid(), name: type, type, clips: [] };
            this.timeline.tracks.push(track);
        }
        return track;
    }

    focusedClip() {
        return this.findClip([...this.selected].at(-1));
    }

    findClip(id) {
        return this.allClips().find(clip => clip.id === id);
    }

    allClips() {
        return this.timeline.tracks.flatMap(track => track.clips);
    }

    visualClips() {
        return this.timeline.tracks
            .filter(track => track.type === "visual")
            .flatMap(track => track.clips);
    }

    clipAtTime(clip, time) {
        return time >= clip.start && time <= clip.start + clip.duration;
    }

    pxPerSecond() {
        return 72 * this.timeline.preview.zoom;
    }

    markDirty() {
        this.timeline.duration = Math.max(0, ...this.allClips().map(clip => clip.start + clip.duration));
        this.dirty = true;
        this.setStatus("Alteracoes pendentes");
    }

    setStatus(text) {
        this.refs.status.textContent = text;
    }

    pathToUrl(path) {
        return `file:///${String(path).replaceAll("\\", "/")}`;
    }
}

if (document.getElementById("projectList")) new AgileApp();
if (document.body.dataset.page === "editor") new Editor();
