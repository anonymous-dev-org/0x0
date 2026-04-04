use ratatui::style::Color;
use serde::{Deserialize, Serialize};

use crate::message::ExecutionTarget;

/// Color palette for agent labels. Assigned by index mod palette length.
const AGENT_COLORS: &[Color] = &[
    Color::Rgb(150, 120, 255), // purple (default single-agent color)
    Color::Green,
    Color::Yellow,
    Color::Magenta,
    Color::Cyan,
    Color::LightRed,
    Color::LightBlue,
];

/// A named AI agent with its own session and provider config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub target: ExecutionTarget,
    #[serde(default)]
    pub server_session_id: Option<String>,
    #[serde(default)]
    pub last_input_tokens: Option<u64>,
    #[serde(default)]
    pub context_window: Option<u64>,
}

impl Agent {
    pub fn new(name: String, target: ExecutionTarget) -> Self {
        Self {
            name,
            target,
            server_session_id: None,
            last_input_tokens: None,
            context_window: None,
        }
    }

    /// Returns the display color for this agent based on its index in the registry.
    pub fn color(index: usize) -> Color {
        AGENT_COLORS[index % AGENT_COLORS.len()]
    }
}

/// Registry of agents in a multi-agent conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistry {
    pub agents: Vec<Agent>,
    #[serde(default)]
    pub last_active: usize,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            last_active: 0,
        }
    }

    pub fn by_name(&self, name: &str) -> Option<&Agent> {
        self.agents
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(name))
    }

    pub fn by_name_mut(&mut self, name: &str) -> Option<&mut Agent> {
        self.agents
            .iter_mut()
            .find(|a| a.name.eq_ignore_ascii_case(name))
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.agents
            .iter()
            .position(|a| a.name.eq_ignore_ascii_case(name))
    }

    pub fn agent_names(&self) -> Vec<&str> {
        self.agents.iter().map(|a| a.name.as_str()).collect()
    }

    /// Color for an agent by name.
    pub fn color_for(&self, name: &str) -> Color {
        self.index_of(name)
            .map(Agent::color)
            .unwrap_or(AGENT_COLORS[0])
    }

    pub fn add(&mut self, agent: Agent) {
        self.agents.push(agent);
    }

    pub fn remove(&mut self, name: &str) -> bool {
        let before = self.agents.len();
        self.agents.retain(|a| !a.name.eq_ignore_ascii_case(name));
        let removed = self.agents.len() < before;
        if removed && self.last_active >= self.agents.len() {
            self.last_active = 0;
        }
        removed
    }

    /// Generate a unique agent name like Agent1, Agent2, ...
    pub fn next_name(&self) -> String {
        let mut n = self.agents.len() + 1;
        loop {
            let name = format!("Agent{n}");
            if self.by_name(&name).is_none() {
                return name;
            }
            n += 1;
        }
    }

    /// Build the agent identity system prompt for a given agent.
    pub fn system_prompt_for(&self, agent_name: &str) -> String {
        let others: Vec<&str> = self
            .agents
            .iter()
            .filter(|a| !a.name.eq_ignore_ascii_case(agent_name))
            .map(|a| a.name.as_str())
            .collect();

        format!(
            "You are {agent_name} in a group chat with the user and other AI agents.\n\
             Messages from agents appear as \"AgentName: ...\".\n\
             Other participants: {}.\n\
             Coordinate to avoid duplicate work. Use @AgentName to address specific agents.\n\
             IMPORTANT: If you have nothing useful to add, respond with exactly \"[pass]\".",
            others.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_target() -> ExecutionTarget {
        ExecutionTarget {
            provider: "claude".to_string(),
            model: "sonnet".to_string(),
            provider_mode: None,
            thinking_effort: None,
        }
    }

    #[test]
    fn agent_registry_basics() {
        let mut reg = AgentRegistry::new();
        reg.add(Agent::new("Agent1".to_string(), test_target()));
        reg.add(Agent::new("Agent2".to_string(), test_target()));

        assert!(reg.agents.len() > 1);
        assert_eq!(reg.agent_names(), vec!["Agent1", "Agent2"]);
        assert!(reg.by_name("agent1").is_some());
        assert!(reg.by_name("AGENT2").is_some());
        assert!(reg.by_name("Agent3").is_none());
    }

    #[test]
    fn agent_registry_remove() {
        let mut reg = AgentRegistry::new();
        reg.add(Agent::new("A".to_string(), test_target()));
        reg.add(Agent::new("B".to_string(), test_target()));
        reg.last_active = 1;

        assert!(reg.remove("B"));
        assert_eq!(reg.agents.len(), 1);
        assert_eq!(reg.last_active, 0); // clamped
    }

    #[test]
    fn next_name_skips_existing() {
        let mut reg = AgentRegistry::new();
        reg.add(Agent::new("Agent1".to_string(), test_target()));
        assert_eq!(reg.next_name(), "Agent2");
        reg.add(Agent::new("Agent2".to_string(), test_target()));
        assert_eq!(reg.next_name(), "Agent3");
    }

    #[test]
    fn system_prompt_includes_others() {
        let mut reg = AgentRegistry::new();
        reg.add(Agent::new("Alice".to_string(), test_target()));
        reg.add(Agent::new("Bob".to_string(), test_target()));

        let prompt = reg.system_prompt_for("Alice");
        assert!(prompt.contains("You are Alice"));
        assert!(prompt.contains("Bob"));
        assert!(!prompt.contains("Alice, "));
    }

    #[test]
    fn color_assignment() {
        assert_eq!(Agent::color(0), Color::Rgb(150, 120, 255));
        assert_eq!(Agent::color(1), Color::Green);
    }
}
