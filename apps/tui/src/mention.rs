/// Result of parsing `@AgentName` mentions from user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMessage {
    /// Agent names that were mentioned (matched case-insensitively).
    pub mentions: Vec<String>,
    /// Original text preserved as-is.
    pub text: String,
}

/// Parse `@AgentName` mentions from input text.
///
/// Only matches registered agent names (case-insensitive) to avoid
/// false positives on email addresses or code. Matches require a word
/// boundary after the name (whitespace, punctuation, or end of string).
pub fn parse_mentions(input: &str, known_agents: &[&str]) -> ParsedMessage {
    let mut mentions = Vec::new();

    for agent in known_agents {
        // Search for @agent_name with case-insensitive matching
        let pattern = format!("@{}", agent);
        let input_lower = input.to_ascii_lowercase();
        let pattern_lower = pattern.to_ascii_lowercase();

        let mut search_from = 0;
        while let Some(pos) = input_lower[search_from..].find(&pattern_lower) {
            let abs_pos = search_from + pos;
            let after = abs_pos + pattern.len();

            // Check word boundary after the name
            let is_boundary =
                after >= input.len() || !input.as_bytes()[after].is_ascii_alphanumeric();

            if is_boundary
                && !mentions
                    .iter()
                    .any(|m: &String| m.eq_ignore_ascii_case(agent))
            {
                mentions.push(agent.to_string());
            }

            search_from = abs_pos + 1;
        }
    }

    ParsedMessage {
        mentions,
        text: input.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_mentions() {
        let result = parse_mentions("hello world", &["Agent1", "Agent2"]);
        assert!(result.mentions.is_empty());
        assert_eq!(result.text, "hello world");
    }

    #[test]
    fn single_mention() {
        let result = parse_mentions("@Agent1 do something", &["Agent1", "Agent2"]);
        assert_eq!(result.mentions, vec!["Agent1"]);
    }

    #[test]
    fn multiple_mentions() {
        let result = parse_mentions("@Agent1 and @Agent2 collaborate", &["Agent1", "Agent2"]);
        assert_eq!(result.mentions.len(), 2);
        assert!(result.mentions.contains(&"Agent1".to_string()));
        assert!(result.mentions.contains(&"Agent2".to_string()));
    }

    #[test]
    fn case_insensitive() {
        let result = parse_mentions("@agent1 do it", &["Agent1"]);
        assert_eq!(result.mentions, vec!["Agent1"]);
    }

    #[test]
    fn no_false_positive_on_partial() {
        // "Agent1x" should not match "Agent1"
        let result = parse_mentions("@Agent1x something", &["Agent1"]);
        assert!(result.mentions.is_empty());
    }

    #[test]
    fn match_at_end_of_string() {
        let result = parse_mentions("hello @Agent1", &["Agent1"]);
        assert_eq!(result.mentions, vec!["Agent1"]);
    }

    #[test]
    fn match_before_punctuation() {
        let result = parse_mentions("@Agent1, do this", &["Agent1"]);
        assert_eq!(result.mentions, vec!["Agent1"]);
    }

    #[test]
    fn no_duplicates() {
        let result = parse_mentions("@Agent1 and @Agent1 again", &["Agent1"]);
        assert_eq!(result.mentions, vec!["Agent1"]);
    }

    #[test]
    fn unknown_agent_ignored() {
        let result = parse_mentions("@Unknown do this", &["Agent1"]);
        assert!(result.mentions.is_empty());
    }
}
