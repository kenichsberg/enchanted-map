## ADDED Requirements

### Requirement: An agent surface for curation

The sidecar SHALL expose its curation capability to an external agent over the Model Context
Protocol, alongside the editor, browser and CI surfaces. The system MUST NOT implement an
agent loop, hold a model credential, or depend on a particular model.

The agent surface MUST consume and produce the same flows and views the other surfaces do, so
a judgment recorded through it is immediately visible to them.

#### Scenario: An agent can enumerate and resolve
- **WHEN** an agent connects and asks for a flow's holes, then resolves one
- **THEN** the judgment is recorded in that flow

#### Scenario: A judgment is visible to the other surfaces
- **WHEN** a judgment is recorded through the agent surface
- **THEN** the editor listing and the browser canvas show the resolved edge without further
  action

#### Scenario: No credential is required of this system
- **WHEN** the agent surface runs
- **THEN** it holds no model credential and makes no request to a model provider

#### Scenario: The agent surface is optional
- **WHEN** no agent is connected
- **THEN** the editor, browser and CI surfaces work exactly as before
