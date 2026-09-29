<div align="center">

# Mana Orchestrate

성배는 소원을 이룬다. Mana Orchestrate(마나 오케스트레이트)는 마력을 알맞은 순간에 알맞은 곳으로 흘려보낸다.

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[하는 일은 세 가지](#하는-일은-세-가지) · [설치](#설치) · [설치한 뒤](#설치한-뒤) · [버전](#버전) · [안에 있는 것](#안에-있는-것)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate` 다음, 프로젝트에서 호스트에게 "Einzbern을 설치해 줘"라고 말한다.

---

Einzbern(아인츠베른)을 Claude Code와 Codex에 연결하는 스킬이다. Einzbern은 이 두 호스트를 위한 프로젝트 기억으로, 작업 항목, 지식, 회의록이 필요한 프롬프트 앞에서 모델 앞에 나타난다. Mana는 흐르는 기억, Orchestrate는 그것을 언제 어디로 흘려보낼지 지휘하는 일. 이 스킬은 모델에게 엔진의 어느 기능을 언제 부를지 가르치고, 설치 마법사를 함께 담고 있다.

## 하는 일은 세 가지

**Einzbern을 들여온다.** 호스트에게 "Einzbern을 설치해 줘"라고 말하면 마법사가 넘겨받는다. 한 화면의 질문, 한 번의 확인, 엔진 다운로드와 검증, 훅 연결. 두 호스트를 한 번에 끝낸다.

**언제 무엇을 할지 모델에게 알려 준다.** 내비게이션 표 한 장. 시작 전에 기억을 꺼내고, 마치면 결과를 작업 항목에 적어 넣고, 결정이 있으면 회의록에, 교훈이 있으면 카드에 쓴다. 표는 엔진이 자기 버전에 맞춰 생성하므로, 모델이 읽는 동사는 엔진의 동사와 하나하나 대응한다.

**스스로는 아무것도 갖지 않는다.** 데이터도, 규칙도, 설정도 없다. 기억은 프로젝트의 `.ether`(에테르, 기록이 형태를 유지하는 곳)에, 원칙과 변수는 Atelier(아틀리에, 마술사의 공방. 여기서는 로컬 관리 페이지)에 있다. 이 스킬은 그 표와 그 마법사일 뿐이다.

## 설치

skills 명령으로:

```
npx skills add tpmoonchefryan/mana-orchestrate
```

또는 호스트에게 말한다. Mana Orchestrate라는 스킬을 찾아서 설치해 줘.

호스트의 skills 디렉터리에 놓인다. Claude Code는 `~/.claude/skills`, Codex는 `~/.agents/skills`. 그다음 프로젝트 디렉터리에서 말한다. Einzbern을 설치해 줘.

마법사가 묻는 것은 새로 설치할지 기존 `.ether`에서 복원할지, 산출물을 어디에 둘지, 그곳이 클라우드 동기화 폴더인지, 언어는 무엇인지, AGENTS.md에 내비게이션 절을 쓸지. 마지막으로 기록할 파일을 전부 나열하고, 당신이 한 번만 확인한다. 엔진은 이 스킬과 같은 버전의 릴리스에서 내려받아 다이제스트를 검증한 뒤에야 놓인다. 로컬 압축 파일이 있으면 오프라인으로도 설치된다.

그 뒤의 일은 모두 같은 마법사의 모드다. 업데이트, 복구, TCRN Workflow에서 이전, 제거, 상태 점검. "Einzbern을 업데이트해 줘"라고 말하면 된다.

커밋도 푸시도 하지 않는다. 당신의 .gitignore를 고치지 않고, 아무것도 지우지 않으며, 엔진 다운로드 외에는 네트워크에 접속하지 않는다.

## 설치한 뒤

당신은 평소처럼 일한다. 매 프롬프트 전에 호스트가 그것을 엔진에 넘겨 한 번 검색하고, 강하게 관련된 제목이 있으면 컨텍스트에 들어가며, 없으면 아무 일도 일어나지 않는다. 모델은 내비게이션 표를 따라 알맞은 순간에 기록한다. 보거나 바꾸고 싶으면 Atelier를 연다.

## 버전

Einzbern과 같은 버전 번호, 같은 릴리스. 현재 {{version}}. 이 README와 SKILL.md의 내비게이션 표는 Einzbern 릴리스 때 생성된다. 이 저장소에서는 문서를 손으로 고치지 않는다.

## 안에 있는 것

- `SKILL.md`: 내비게이션 표와 세 단계 절차. 평소 세션은 이 파일만 읽는다.
- `references/`: 설치, 복원, 업데이트, 이전, 제거, 상태 점검의 마법사 텍스트. 설치할 때만 읽는다.

## 전체 문서

Einzbern의 README와 Wiki.

## 라이선스

Apache-2.0
