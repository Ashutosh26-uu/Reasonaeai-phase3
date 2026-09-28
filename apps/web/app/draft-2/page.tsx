import { ArrowDownRight, ArrowUpRight, MoveUpRight } from "lucide-react";
import Image from "next/image";
import styles from "./page.module.css";

const signal = Array.from({ length: 47 }, (_cell, row) =>
  Array.from({ length: 105 }, (_columnCell, column) => {
    const x = (column - 66) / 1.45;
    const y = (row - 23) * 1.15;
    const radius = Math.hypot(x, y);
    const ring = [9, 17, 25, 33].some(
      (distance) => Math.abs(radius - distance) < 0.43
    );
    if (ring) {
      return (column + row) % 11 === 0 ? "+" : ":";
    }
    if ((column * 17 + row * 31) % 43 === 0) {
      return ".";
    }
    return " ";
  }).join("")
).join("\n");

const marginNotation = `+-----+-----+-----+-----+-----+
| 01  | 02  | 03  | 04  | 05  |
+-----+-----+-----+-----+-----+`;

const processNotation = `INPUT ........... PLAN .......... PROOF
  :                 :               :
  +---- inspect ----+---- verify ---+`;

const signalRibbon = Array.from({ length: 11 }, (_line, row) =>
  Array.from({ length: 112 }, (_point, column) => {
    const wave = 5 + 2.5 * Math.sin(column / 9) + Math.sin(column / 3.2);
    if (Math.abs(row - wave) < 0.42) {
      return column % 13 === 0 ? "+" : "*";
    }
    return row === 5 && column % 7 === 0 ? "." : " ";
  }).join("")
).join("\n");

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

export default function ThemePreviewSecondDraftPage() {
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

          <div className={styles.draftSwitch}>
            <a href="/">01</a>
            <span aria-current="page">02</span>
          </div>
        </header>

        <section aria-labelledby="hero-title" className={styles.hero} id="top">
          <pre aria-hidden="true" className={styles.heroField}>
            {signal}
          </pre>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>
              <span className={styles.square} />
              INTERFACE STUDY / SECOND DRAFT
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
              <span className={styles.actionNote}>02 / ASCII FIELD STUDY</span>
            </div>
          </div>

          <div aria-hidden="true" className={styles.heroVisual}>
            <div className={styles.visualTopline}>
              <span>REASON / SYSTEM 01</span>
              <span>◦ ◦ ◦</span>
            </div>
            <pre className={styles.ascii}>{marginNotation}</pre>
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
              <span>STUDY 02 / 2026</span>
            </div>
          </div>
        </section>

        <div aria-hidden="true" className={styles.signalRibbon}>
          <span>SIGNAL / 002</span>
          <pre>{signalRibbon}</pre>
          <span>THOUGHT → PROOF</span>
        </div>

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
            <pre aria-hidden="true" className={styles.approachArt}>
              {processNotation}
            </pre>
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
          <span>REASONATEAI / INTERFACE STUDY 02</span>
          <a href="#top">
            BACK TO TOP <ArrowUpRight size={14} strokeWidth={1.5} />
          </a>
        </footer>
      </div>
    </main>
  );
}
