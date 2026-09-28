import { ArrowDownRight, ArrowUpRight, MoveUpRight } from "lucide-react";
import Image from "next/image";
import styles from "./page.module.css";

const signal = [
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
  "· · · · · · · · · · · · · · · · · · · · · ·",
];

const steps = [
  {
    detail: "Turn a rough idea into a clear brief.",
    index: "01",
    title: "Understand",
  },
  {
    detail: "Make the important decisions visible.",
    index: "02",
    title: "Architect",
  },
  {
    detail: "Show the work, evidence, and result.",
    index: "03",
    title: "Build & verify",
  },
];

export default function ThemePreviewPage() {
  return (
    <main className={styles.page}>
      <div aria-hidden="true" className={styles.rail}>
        R / A — 03
      </div>

      <div className={styles.frame}>
        <header className={styles.header}>
          <a aria-label="ReasonateAI, top" className={styles.brand} href="#top">
            <span className={styles.brandMark}>
              <Image
                alt=""
                height={40}
                priority
                src="/brand/reasonateai-icon.png"
                width={40}
              />
            </span>
            <span className={styles.brandName}>
              reasonate<span>ai</span>
            </span>
          </a>

          <nav aria-label="Page sections" className={styles.nav}>
            <a href="#approach">Approach</a>
            <a href="#interface">Interface</a>
            <a href="#palette">Palette</a>
          </nav>

          <a className={styles.headerTag} href="/draft-2">
            VIEW DRAFT 02 ↗
          </a>
        </header>

        <section aria-labelledby="hero-title" className={styles.hero} id="top">
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>
              <span className={styles.square} />
              THE AI CTO FOR WHAT&apos;S NEXT
            </div>
            <h1 id="hero-title">
              From thought
              <br />
              <em>to proof.</em>
            </h1>
            <p className={styles.heroText}>
              A calmer place to turn an idea into working software. Make the
              decisions visible. Build with intent. See the evidence.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href="#interface">
                Explore the interface{" "}
                <MoveUpRight size={16} strokeWidth={1.5} />
              </a>
              <span className={styles.actionNote}>
                A visual preview, not a live workspace
              </span>
            </div>
          </div>

          <div aria-hidden="true" className={styles.heroVisual}>
            <div className={styles.visualTopline}>
              <span>REASON / SYSTEM 01</span>
              <span>◦ ◦ ◦</span>
            </div>
            <pre className={styles.ascii}>{signal.join("\n")}</pre>
            <div className={styles.orbit}>
              <div className={styles.orbitInner}>
                <Image
                  alt=""
                  height={170}
                  src="/brand/reasonateai-icon.png"
                  width={200}
                />
              </div>
            </div>
            <div className={styles.visualFootline}>
              <span>INTENT → EXECUTION</span>
              <span>EST. 2026</span>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="approach-title"
          className={styles.approach}
          id="approach"
        >
          <div className={styles.sectionIntro}>
            <span className={styles.sectionIndex}>/ 01 — THE APPROACH</span>
            <h2 id="approach-title">Clarity at every step.</h2>
            <p>
              The product should feel as considered as the work behind it:
              direct language, quiet surfaces, and the right detail at the right
              time.
            </p>
          </div>
          <div className={styles.stepList}>
            {steps.map((step) => (
              <div className={styles.step} key={step.index}>
                <span className={styles.stepIndex}>{step.index}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.detail}</p>
                </div>
                <ArrowUpRight aria-hidden="true" size={18} strokeWidth={1.25} />
              </div>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="interface-title"
          className={styles.interfaceSection}
          id="interface"
        >
          <div className={styles.sectionHeader}>
            <div>
              <span className={styles.sectionIndex}>
                / 02 — INTERFACE STUDY
              </span>
              <h2 id="interface-title">A workspace with room to think.</h2>
            </div>
            <span className={styles.studyLabel}>
              STATIC CONTENT / VISUAL EXAMPLE
            </span>
          </div>

          <div className={styles.workspace}>
            <div className={styles.workspaceSide}>
              <div className={styles.sideHeader}>
                <span className={styles.smallMark}>R.</span>
                <span>PROJECT SPACE</span>
              </div>
              <div className={styles.sideProject}>
                <span>Studio booking platform</span>
                <ArrowDownRight
                  aria-hidden="true"
                  size={16}
                  strokeWidth={1.25}
                />
              </div>
              <div className={styles.sideDivider} />
              <span className={styles.sideCaption}>WORKFLOW</span>
              <div className={styles.sideItemActive}>
                01 <span>Conversation</span>
              </div>
              <div className={styles.sideItem}>
                02 <span>Requirements</span>
              </div>
              <div className={styles.sideItem}>
                03 <span>Architecture</span>
              </div>
              <div className={styles.sideItem}>
                04 <span>Evidence</span>
              </div>
              <div className={styles.sideBottom}>REASONATE / DESIGN STUDY</div>
            </div>

            <div className={styles.workspaceMain}>
              <div className={styles.workspaceTopbar}>
                <span>
                  CONVERSATION{" "}
                  <span className={styles.topbarMuted}>/ EXAMPLE</span>
                </span>
                <span className={styles.topbarDots}>
                  ● <span>●</span> <span>●</span>
                </span>
              </div>
              <div className={styles.conversation}>
                <div className={styles.messageLabel}>YOUR IDEA</div>
                <p className={styles.userMessage}>
                  I want to make it easier for people to find and book
                  independent creative studios.
                </p>
                <div className={styles.responseDivider} />
                <div className={styles.messageLabel}>
                  REASONATEAI <span> / EXAMPLE RESPONSE</span>
                </div>
                <h3>Let&apos;s make the first version useful.</h3>
                <p className={styles.responseText}>
                  We&apos;ll start with a clear booking journey, availability
                  that owners can manage, and a simple way to confirm each
                  reservation.
                </p>
                <div className={styles.responseCards}>
                  <div>
                    <span>01 / SCOPE</span>
                    <strong>Define the core flow</strong>
                  </div>
                  <div>
                    <span>02 / DECISION</span>
                    <strong>Review the plan</strong>
                  </div>
                </div>
              </div>
              <div className={styles.composer}>
                <span>Ask a question or describe what you need...</span>
                <span className={styles.composerArrow}>
                  <MoveUpRight size={16} strokeWidth={1.5} />
                </span>
              </div>
            </div>
          </div>
          <p className={styles.studyNote}>
            An interface sketch to test the visual system. The conversation
            above is sample copy.
          </p>
        </section>

        <section
          aria-labelledby="palette-title"
          className={styles.palette}
          id="palette"
        >
          <div>
            <span className={styles.sectionIndex}>/ 03 — MATERIALS</span>
            <h2 id="palette-title">Light, shadow, signal.</h2>
          </div>
          <div className={styles.swatches}>
            <div className={`${styles.swatch} ${styles.swatchInk}`}>
              <span>01 / INK</span>
              <strong>#171A19</strong>
            </div>
            <div className={`${styles.swatch} ${styles.swatchGraphite}`}>
              <span>02 / GRAPHITE</span>
              <strong>#2D3130</strong>
            </div>
            <div className={`${styles.swatch} ${styles.swatchSilver}`}>
              <span>03 / SILVER</span>
              <strong>#BFC2BE</strong>
            </div>
            <div className={`${styles.swatch} ${styles.swatchPaper}`}>
              <span>04 / PAPER</span>
              <strong>#F3F3EE</strong>
            </div>
          </div>
        </section>

        <footer className={styles.footer}>
          <span>REASONATEAI / INTERFACE STUDY 01</span>
          <a href="#top">
            BACK TO TOP <ArrowUpRight size={14} strokeWidth={1.5} />
          </a>
        </footer>
      </div>
    </main>
  );
}
