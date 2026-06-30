# DF-02: Skills System Data Flow

**Feature:** Skills — Prompt template library, SKILL.md system, Design Templates  
**Actors:** User, Web UI, Daemon, Agent CLI, Filesystem

---

## 1. Skill Discovery & Listing

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    U->>W: Mở Settings → Skills / Home picker
    W->>D: GET /api/skills
    D->>FS: Scan skills/ directory (built-in)
    D->>FS: Scan {dataDir}/user-skills/ (user-installed)
    D->>D: Parse SKILL.md frontmatter cho mỗi skill
    D-->>W: SkillsResponse { skills: SkillSummary[] }
    W-->>U: Hiển thị gallery với filter, preview
```

---

## 2. Skill Selection & Apply to Project

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant FS as 📁 Filesystem

    U->>W: Chọn Skill trong Home → New Project
    W->>D: GET /api/skills/:id
    D->>FS: Đọc SKILL.md (body + frontmatter)
    D-->>W: SkillDetail { skill }
    W-->>U: Preview mode, description

    U->>W: Create project với skill
    W->>D: POST /api/projects { skillId, pendingPrompt }
    D->>DB: INSERT Project (skillId = skill.id)
    D->>FS: mkdir .od/projects/<uuid>/
    D-->>W: { project }
```

---

## 3. SKILL.md Injection vào Prompt Stack

```mermaid
flowchart TD
    subgraph SKILL_LOAD["Daemon: Load Skill for Run"]
        SID[skillId from project] --> FIND[Locate SKILL.md in registry]
        FIND --> PARSE[Parse frontmatter:\nname, description, triggers, mode\nplatform, craftRequires]
        PARSE --> BODY[Read .md body]

        BODY --> INJECT[Inject vào prompt system]
    end

    subgraph SKILL_SIDEFILES["Skill Side Files"]
        BODY --> CHK{Skill có side files?}
        CHK -->|Yes| SF[references/*.md\ntemplate.html\nassets/]
        SF --> INJECT
        CHK -->|No| INJECT
    end

    INJECT --> AGENT[🤖 Agent CLI\nreads CLAUDE.md + SKILL.md context]
```

---

## 4. User Skill Import Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant FS as 📁 Filesystem

    U->>W: Settings → Skills → Import
    U->>W: Paste SKILL.md content
    W->>D: POST /api/skills/import\n{ name, description, body, triggers }
    D->>D: Validate frontmatter
    D->>FS: Write {dataDir}/user-skills/<slug>/SKILL.md
    D-->>W: SkillImportResponse { skill: SkillSummary }
    W-->>U: Skill xuất hiện trong danh sách (source: 'user')
```

---

## 5. Skill Install từ GitHub

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant GH as 🌐 GitHub API
    participant FS as 📁 Filesystem

    U->>W: POST /api/install\n{ source: 'github', url: 'https://github.com/...' }
    W->>D: POST /api/install { source, url }
    D->>GH: Clone/download repo
    D->>D: Locate open-design.json + SKILL.md
    D->>D: Validate manifest (Zod schema)
    D->>FS: Write {dataDir}/user-skills/<id>/
    D-->>W: InstallSkillResponse { skill }
    W-->>U: Skill installed, available trong registry
```

---

## 6. Design Templates vs Skills

```mermaid
flowchart LR
    subgraph REGISTRY["Registry Layer"]
        S[Skills\nmode: prototype/deck/image...] 
        DT[Design Templates\n= SkillSummary shape\nSeparate root in FS]
    end

    subgraph UI_SURFACE["UI Surfaces"]
        HOME[Home — New Project\nChip Rail]
        SETTINGS_SKILLS[Settings → Skills]
        SETTINGS_TEMPLATES[Settings → Templates\n(separate list)]
        EXAMPLES[Examples Gallery\nscenario-derived cards]
    end

    S --> HOME
    S --> SETTINGS_SKILLS
    S --> EXAMPLES
    DT --> SETTINGS_TEMPLATES
    DT --> HOME
```

---

## 7. @-mention Skill (Per-turn override)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon

    U->>W: Gõ "@" trong chat → chọn skill
    W->>D: GET /api/skills (với search query)
    D-->>W: Filtered SkillSummary[]
    U->>W: Submit message với skillIds: [id1, id2]
    W->>D: POST message { skillIds: ['id1', 'id2'] }
    Note over D: Per-turn skills được inject vào prompt\nKHÔNG thay đổi project.skillId (không persist)
    D->>D: Merge per-turn skillIds vào prompt stack
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Built-in skills | `skills/` in repo | Read-only |
| User skills | `{dataDir}/user-skills/<id>/SKILL.md` | Mutable, delete allowed |
| Active skill ID | SQLite `projects.skillId` | Persisted per project |
| Disabled skills | `config.json → disabledSkills[]` | Global preference |
| Skill body cache | In-memory | Không cache to disk |
