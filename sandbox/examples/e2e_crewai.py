#!/usr/bin/env python3
"""
SILO E2E Demo: CrewAI Multi-Agent Research Task

This script validates the full SILO → CrewAI → LLM → Audit pipeline.
Run inside the sandbox after `silo build --framework crewai && silo start`.

What it tests:
  1. CrewAI imports and initialises
  2. SILO callbacks connect to the trace collector
  3. LLM calls are routed through the SILO proxy
  4. Tool calls appear in `silo logs`
  5. Trace events appear in `silo logs --category trace`

Usage:
  silo connect
  python3 /workspace/e2e_crewai.py

Prerequisites:
  - OPENAI_API_KEY or ANTHROPIC_API_KEY set in silo config
  - Sandbox running with `silo start --framework crewai`
"""

import sys
import os

# ---------------------------------------------------------------------------
# 1. Verify CrewAI is importable
# ---------------------------------------------------------------------------

try:
    from crewai import Agent, Task, Crew
    print("✅ CrewAI imported successfully")
except ImportError as e:
    print(f"❌ CrewAI import failed: {e}")
    print("   Run: pip install crewai crewai-tools")
    sys.exit(1)

# ---------------------------------------------------------------------------
# 2. Setup SILO callbacks
# ---------------------------------------------------------------------------

try:
    from silo_callbacks import SiloCrewCallbacks, silo_trace
    listener = SiloCrewCallbacks()
    listener.setup()
    print("✅ SILO callbacks registered")
except ImportError:
    print("⚠️  SILO callbacks not available (continuing without traces)")
    listener = None

# ---------------------------------------------------------------------------
# 3. Define a simple 2-agent crew
# ---------------------------------------------------------------------------

researcher = Agent(
    role="Researcher",
    goal="Find the key facts about the given topic",
    backstory="You are a research specialist who excels at finding and summarising information.",
    verbose=True,
    allow_delegation=False,
)

writer = Agent(
    role="Writer",
    goal="Write a concise summary based on the research findings",
    backstory="You are a skilled technical writer who turns research into clear, readable summaries.",
    verbose=True,
    allow_delegation=False,
)

research_task = Task(
    description="Research the topic: 'What is Docker container security?'. Provide 3-5 key points.",
    expected_output="A bullet list of 3-5 key facts about Docker container security.",
    agent=researcher,
    callback=listener.task_callback if listener else None,
)

write_task = Task(
    description="Write a 2-paragraph summary based on the research findings about Docker container security.",
    expected_output="A concise 2-paragraph summary about Docker container security.",
    agent=writer,
    callback=listener.task_callback if listener else None,
)

# ---------------------------------------------------------------------------
# 4. Run the crew
# ---------------------------------------------------------------------------

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    verbose=True,
)

print("\n🚀 Starting CrewAI crew...\n")
print("─" * 60)

try:
    result = crew.kickoff()
    print("─" * 60)
    print(f"\n✅ Crew completed successfully!")
    print(f"\n📝 Result:\n{result}")
except Exception as e:
    print(f"\n❌ Crew execution failed: {e}")
    sys.exit(1)

# ---------------------------------------------------------------------------
# 5. Verification checklist
# ---------------------------------------------------------------------------

print("\n" + "─" * 60)
print("🔍 Verification Steps:")
print("  1. Run `silo logs` on the host — you should see LLM calls")
print("  2. Run `silo logs --category tool_call` — tool invocations")
print("  3. Run `silo logs --category trace` — agent lifecycle events")
print("  4. Run `silo logs --framework crewai` — all CrewAI activity")
print("  5. Run `silo logs --agent Researcher` — just the Researcher agent")
print("─" * 60)
