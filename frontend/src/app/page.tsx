import React from 'react';
import Link from 'next/link';
import { ArrowRight, FileSearch, ListChecks, PenLine, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import { HealthDashboard } from '@/components/HealthDashboard';
import { Button } from '@/components/ui/Button';
import { Reveal } from '@/components/landing/Reveal';
import { HeroDemoCard } from '@/components/landing/HeroDemoCard';
import { PipelineFlow } from '@/components/landing/PipelineFlow';

// Measured with the project's evaluation harness (docs/eval/ML_FAILURE_ANALYSIS.md) and k6 load
// tests (docs/PERFORMANCE.md), on synthetic or auto-labeled data on one machine.
const METRICS = [
  { value: '99.6%', label: 'of resume pairs ranked in the right order', note: 'held-out set, 252 pairs' },
  { value: '80.6%', label: 'of scores in the right strong / medium / weak band', note: 'same held-out set' },
  { value: '98.2%', label: 'ranking accuracy on realistic, long job posts', note: 'handwritten set' },
  { value: '0', label: 'failed requests under load', note: 'of 180,791 in k6 tests' },
];

const FEATURES = [
  {
    Icon: FileSearch,
    tone: 'green',
    title: 'Read like an ATS',
    body: 'Find the layout problems that break applicant-tracking parsers: columns, tables, text in headers, scanned pages.',
  },
  {
    Icon: ListChecks,
    tone: 'orange',
    title: 'See what the job wants',
    body: 'Required and preferred skills are weighed separately, and "either X or Y" counts once. You see exactly what is missing.',
  },
  {
    Icon: PenLine,
    tone: 'green',
    title: 'Improve with care',
    body: 'Optional AI suggestions rewrite weak bullets. Every rewrite is checked against your own resume text before you see it.',
  },
];

export default function HomePage() {
  return (
    <div className="flex-1 w-full">
      {/* Hero */}
      <section className="border-b border-border">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-24">
          <div className="space-y-7">
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-highlight-strong" aria-hidden="true" />
                Resume and job matching, explained
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl lg:text-[3.5rem]">
                Know why your resume matches a job, <em className="text-primary not-italic sm:italic">or why it doesn&apos;t.</em>
              </h1>
            </Reveal>

            <Reveal delay={0.12}>
              <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
                ResuMatch reads your resume the way an applicant-tracking system does, compares it with the job
                post, and shows the skills and passages behind every score.
              </p>
            </Reveal>

            <Reveal delay={0.18}>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link href="/dashboard" className="inline-block">
                  <Button size="lg" rightIcon={<ArrowRight className="h-4 w-4" />}>
                    Go to Workspace
                  </Button>
                </Link>
                <Link href="/signup" className="inline-block">
                  <Button variant="secondary" size="lg">
                    Create Account
                  </Button>
                </Link>
              </div>
            </Reveal>
          </div>

          <div className="flex justify-center lg:justify-end">
            <HeroDemoCard />
          </div>
        </div>
      </section>

      {/* Measured results */}
      <section aria-labelledby="metrics-heading" className="bg-secondary border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 id="metrics-heading" className="sr-only">
            Measured results
          </h2>
          <dl className="grid grid-cols-2 gap-y-8 lg:grid-cols-4 lg:divide-x lg:divide-border">
            {METRICS.map((m, i) => (
              <Reveal key={m.label} delay={i * 0.06} className="px-2 lg:px-6">
                <dt className="sr-only">{m.label}</dt>
                <dd>
                  <span className="font-display text-4xl font-semibold text-foreground">{m.value}</span>
                  <span className="mt-1 block text-sm text-foreground">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">{m.note}</span>
                </dd>
              </Reveal>
            ))}
          </dl>
          <p className="mt-8 text-xs text-muted-foreground">
            Measured with the project&apos;s evaluation harness and load tests, on synthetic or auto-labeled data.
          </p>
        </div>
      </section>

      {/* Features */}
      <section aria-labelledby="features-heading" className="border-b border-border">
        <div className="mx-auto max-w-6xl space-y-12 px-4 py-20 sm:px-6">
          <Reveal className="max-w-2xl space-y-3">
            <h2 id="features-heading" className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Three questions, answered honestly
            </h2>
            <p className="text-muted-foreground">
              Will a parser read my resume? Does it fit this job? What should I change? Scores come from the
              matching model, never from a chatbot.
            </p>
          </Reveal>

          <div className="grid gap-10 md:grid-cols-3">
            {FEATURES.map(({ Icon, tone, title, body }, i) => (
              <Reveal key={title} delay={i * 0.08} className="space-y-3">
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl ${
                    tone === 'green' ? 'bg-accent text-primary' : 'bg-highlight text-highlight-foreground'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="text-lg font-semibold text-foreground">{title}</h3>
                <p className="leading-relaxed text-muted-foreground">{body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Pipeline */}
      <section aria-labelledby="pipeline-heading" className="bg-secondary border-b border-border">
        <div className="mx-auto max-w-6xl space-y-12 px-4 py-20 sm:px-6">
          <Reveal className="max-w-2xl space-y-3">
            <h2 id="pipeline-heading" className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              How a score is made
            </h2>
            <p className="text-muted-foreground">Six steps, the same for every resume and every job.</p>
          </Reveal>
          <PipelineFlow />
        </div>
      </section>

      {/* Privacy */}
      <section aria-labelledby="privacy-heading" className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <Reveal>
            <div className="grid gap-10 rounded-2xl border border-border bg-accent/60 p-8 sm:p-10 lg:grid-cols-[1fr_1.4fr]">
              <div className="space-y-3">
                <h2 id="privacy-heading" className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  Your resume stays yours
                </h2>
                <p className="text-muted-foreground">
                  No model training on your files. Every query is scoped to your account.
                </p>
              </div>
              <ul className="grid gap-5 sm:grid-cols-3">
                {[
                  { Icon: Lock, text: 'Files live in private storage behind short-lived links.' },
                  { Icon: ShieldCheck, text: 'Personal details are removed before any text reaches an optional AI model.' },
                  { Icon: Trash2, text: 'Deleting your account removes your records, embeddings and files.' },
                ].map(({ Icon, text }) => (
                  <li key={text} className="space-y-2 text-sm leading-relaxed text-foreground">
                    <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                    <p>{text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Health */}
      <section aria-labelledby="diagnostics-heading">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mb-4">
            <h2 id="diagnostics-heading" className="text-base font-semibold text-foreground">
              System status
            </h2>
            <p className="text-sm text-muted-foreground">
              Live health of the API gateway, ML service, database, queue and file storage.
            </p>
          </div>
          <HealthDashboard />
        </div>
      </section>
    </div>
  );
}
