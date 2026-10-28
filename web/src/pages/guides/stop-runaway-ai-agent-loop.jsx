import "../../styles/pages.css";
import "./stop-runaway-ai-agent-loop.css";
import Page from "../../components/Page.jsx";

export const head = {
  "title": "Stop a Runaway AI Agent Loop Before It Bills You | SpendVeto",
  "description": "Freeze an AI agent stuck repeating the same tool call before the next model call is paid for, with a kill switch, rate limits and budgets as backstops.",
  "path": "/guides/stop-runaway-ai-agent-loop",
  "ogTitle": "How to stop a runaway AI agent loop before it runs up a bill",
  "ogType": "article",
  "jsonLd": [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          "@id": "https://spendveto.com/guides/stop-runaway-ai-agent-loop#article",
          "headline": "How to stop a runaway AI agent loop before it runs up a bill",
          "description": "Freeze an AI agent stuck repeating the same tool call before the next model call is paid for, with a kill switch, rate limits and budgets as backstops.",
          "url": "https://spendveto.com/guides/stop-runaway-ai-agent-loop",
          "datePublished": "2026-10-18",
          "dateModified": "2026-10-18",
          "author": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "publisher": {
            "@type": "Organization",
            "@id": "https://spendveto.com/#org",
            "name": "SpendVeto"
          },
          "about": [
            "AI agent loop",
            "kill switch",
            "LLM cost control"
          ],
          "proficiencyLevel": "Beginner"
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "SpendVeto",
              "item": "https://spendveto.com/"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": "Guides",
              "item": "https://spendveto.com/guides"
            },
            {
              "@type": "ListItem",
              "position": 3,
              "name": "Stop runaway agent loops",
              "item": "https://spendveto.com/guides/stop-runaway-ai-agent-loop"
            }
          ]
        },
        {
          "@type": "HowTo",
          "name": "How to stop a runaway AI agent loop before it runs up a bill",
          "description": "Put the agent behind SpendVeto: it fingerprints each agent's last tool call and its result, and when the same successful call returns the same result six times within five minutes (both configurable) it freezes that agent before the next model call is paid for. Budgets, a per-minute rate limit and a manual kill switch catch whatever the loop detector doesn't.",
          "tool": [
            {
              "@type": "HowToTool",
              "name": "SpendVeto"
            }
          ],
          "step": [
            {
              "@type": "HowToStep",
              "position": 1,
              "name": "Route the agent through SpendVeto",
              "text": "ANTHROPIC_BASE_URL=http://127.0.0.1:8402 or OPENAI_BASE_URL=http://127.0.0.1:8402/v1 — loop detection is on by default."
            },
            {
              "@type": "HowToStep",
              "position": 2,
              "name": "Tune the loop detector",
              "text": "Set llm.loop.threshold and llm.loop.windowSeconds in the policy; retries of failed requests never count."
            },
            {
              "@type": "HowToStep",
              "position": 3,
              "name": "Keep budgets as a backstop",
              "text": "A daily and hourly cap per agent limits the damage of any loop the detector doesn't recognize."
            },
            {
              "@type": "HowToStep",
              "position": 4,
              "name": "Use the kill switch",
              "text": "spendveto freeze <agent> or the Console refuses every request from that agent until a human unfreezes it."
            }
          ]
        },
        {
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "What is an AI agent kill switch?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "A control that stops an agent from spending or acting immediately, regardless of what it is doing. In SpendVeto, freezing an agent refuses every model request and payment it makes until a human unfreezes it — from the Console or with spendveto freeze."
              }
            },
            {
              "@type": "Question",
              "name": "Will the loop detector stop legitimate repeated calls?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Only identical successful tool calls with identical results count, and the threshold (6 in 5 minutes by default) is configurable. Observe mode shows what would have been frozen before you enforce it."
              }
            },
            {
              "@type": "Question",
              "name": "Does it work for agents built with LangChain or CrewAI?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes, if they call an OpenAI- or Anthropic-compatible API: point the framework's base URL at SpendVeto. Loop detection works on the requests themselves, whatever framework sends them."
              }
            }
          ]
        }
      ]
    }
  ]
};

export default function StopRunawayAiAgentLoopPage() {
  return (
    <Page note={<>Every behavior described here is covered by SpendVeto's automated test suite.</>}>
      <article className="pg">
        <p className="crumbs">
          <a href="/">SpendVeto</a>
          {" "}/{" "}
          <a href="/guides">Guides</a>
          {" "}/ Stop runaway agent loops
        </p>
        <h1>How to stop a runaway AI agent loop before it runs up a bill</h1>
        <p className="answer">
          Put the agent behind SpendVeto: it fingerprints each agent's last tool call and its result, and when the same{" "}
          <i>successful</i>
          {" "}call returns the same result six times within five minutes (both configurable) it freezes that agent before the next model call is paid for. Budgets, a per-minute rate limit and a manual kill switch catch whatever the loop detector doesn't.
        </p>
        <h2>Why a budget alone isn't enough</h2>
        <p>
          A budget limits how much a loop can cost. It doesn't notice the loop. An agent repeating the same failing plan burns its whole daily budget, and the work is lost too. Public reports put the bills in four and five figures: about{" "}
          <a className="inline" href="https://devtoolpicks.com/blog/ai-agents-runaway-claude-code-bills-overnight-2026" rel="noopener">
            $6,000 overnight
          </a>
          {" "}from one Claude Code command, and about{" "}
          <a className="inline" href="https://linas.substack.com/p/ai-agent-loop-governance" rel="noopener">
            $50,000 in under an hour
          </a>
          {" "}in a cited red-team case.
        </p>
        <h2>How the loop detector works</h2>
        <ol>
          <li>
            For every model request, SpendVeto fingerprints the agent's{" "}
            <b>last tool call and its result</b>
            , with ids, cache markers and thinking stripped so that only behavior counts.
          </li>
          <li>
            If the same fingerprint appears{" "}
            <b>6 times within 300 seconds</b>
            , the agent is frozen (source{" "}
            <code>llm-loop</code>
            ), and its next request is refused before the provider sees it.
          </li>
          <li>Only <b>successful</b> repeats count. An SDK retrying a failed request is being careful, not looping.</li>
          <li>A human reviews and unfreezes the agent in the Console or with <code>spendveto unfreeze</code>.</li>
        </ol>
        <pre className="term">
          {"{\n  \"$schema\": \"https://spendveto.com/schemas/policy-v1.json\",\n  \"llm\": { \"loop\": { \"enabled\": true, \"threshold\": 6, \"windowSeconds\": 300 }, \"maxRequestsPerMinute\": 60, \"dailyBudgetUSD\": 25 }\n}"}
        </pre>
        <h2>The other three stops</h2>
        <ul>
          <li>
            <b>Rate limit.</b>
            {" "}More than{" "}
            <code>maxRequestsPerMinute</code>
            {" "}gets a real 429 with{" "}
            <code>retry-after</code>
            , so well-behaved clients slow down instead of hammering.
          </li>
          <li>
            <b>Budgets.</b>
            {" "}Daily, hourly, per-request and per-session caps per agent, checked before each request.
          </li>
          <li>
            <b>Kill switch.</b>
            {" "}
            <code>spendveto freeze &lt;agent&gt;</code>
            {" "}refuses everything from that agent. For agents that pay with x402, a burst of payment attempts (10 inside 10 seconds by default) freezes the wallet automatically.
          </li>
        </ul>
        <h2>Try it without blocking anything</h2>
        <pre className="term">
          {"spendveto observe   # record what would have been blocked or frozen; block nothing\nspendveto enforce   # turn enforcement back on"}
        </pre>
        <p>
          Observe mode books every request with a{" "}
          <code>wouldBlock</code>
          {" "}note, so you can tune the threshold on real traffic before it ever stops an agent.
        </p>
        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>What is an AI agent kill switch?</summary>
            <p>
              A control that stops an agent from spending or acting immediately, regardless of what it is doing. In SpendVeto, freezing an agent refuses every model request and payment it makes until a human unfreezes it — from the Console or with{" "}
              <code>spendveto freeze</code>
              .
            </p>
          </details>
          <details>
            <summary>Will the loop detector stop legitimate repeated calls?</summary>
            <p>
              Only identical successful tool calls with identical results count, and the threshold (6 in 5 minutes by default) is configurable. Observe mode shows what would have been frozen before you enforce it.
            </p>
          </details>
          <details>
            <summary>Does it work for agents built with LangChain or CrewAI?</summary>
            <p>
              Yes, if they call an OpenAI- or Anthropic-compatible API: point the framework's base URL at SpendVeto. Loop detection works on the requests themselves, whatever framework sends them.
            </p>
          </details>
        </div>
        <h2>Related guides</h2>
        <div className="related">
          <a href="/guides/ai-agent-budget">
            AI agent budgets
            <span>
              Per-agent caps, team and customer tag budgets across agents, and one cost report across providers.
            </span>
          </a>
          <a href="/guides/x402-spending-limits">
            x402 spending limits
            <span>
              Caps, approvals, payee and chain allowlists for x402, enforced server-side before anything is signed or settled.
            </span>
          </a>
          <a href="/guides/ai-agent-card-controls">
            AI agent card controls
            <span>
              Real-time decisions on Stripe Issuing and Lithic swipes: caps, daily budgets, velocity, MCC blocks, kill switch.
            </span>
          </a>
        </div>
        <div className="row-btns">
          <a className="pill pill-primary" href="/docs">Get started →</a>
          <a className="pill pill-ghost" href="/console/">Open the console demo</a>
        </div>
        <p className="meta">Updated 2026-10-18 · SpendVeto v0.29.0</p>
      </article>
    </Page>
  );
}
