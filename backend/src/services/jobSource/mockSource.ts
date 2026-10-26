import crypto from 'crypto';
import type { JobSearchQuery, JobSource, JobSourceOptions, RawJobListing } from './types.js';
import { sanitizeScrapedContent } from './sanitizer.js';

interface MockFixture {
  title: string;
  company: string;
  location: string;
  sourceUrl: string;
  description: string;
  keywords: string[];
}

const MOCK_FIXTURES: MockFixture[] = [
  {
    title: 'Senior Backend Engineer',
    company: 'CloudScale Technologies',
    location: 'Remote',
    sourceUrl: 'https://boards.greenhouse.io/cloudscale/jobs/4829101',
    keywords: ['backend', 'python', 'fastapi', 'postgresql', 'docker', 'redis', 'microservices'],
    description: `CloudScale Technologies is seeking a Senior Backend Engineer to build high-throughput, fault-tolerant REST and streaming services.
Requirements:
- 5+ years building distributed backend services in Python (FastAPI, asyncio) or Node.js.
- Strong database expertise with PostgreSQL, schema design, and index optimization.
- Hands-on experience with Redis, Docker, and containerized microservice architectures.
- Experience writing unit and integration tests with CI/CD automation.`,
  },
  {
    title: 'Full Stack Engineer',
    company: 'Vanguard Systems',
    location: 'New York, NY (Hybrid)',
    sourceUrl: 'https://jobs.lever.co/vanguardsystems/9821034',
    keywords: ['full stack', 'fullstack', 'react', 'typescript', 'nodejs', 'postgresql', 'docker'],
    description: `Vanguard Systems is hiring a Full Stack Engineer to lead product feature development across web interfaces and backend APIs.
Requirements:
- Proficiency in React, TypeScript, and modern state management.
- Experience designing RESTful APIs in Node.js or Python.
- Working knowledge of PostgreSQL and Docker containers.
- Passion for responsive, accessible, and clean user interfaces.`,
  },
  {
    title: 'DevOps & Cloud Infrastructure Engineer',
    company: 'Apex Infrastructure',
    location: 'Remote',
    sourceUrl: 'https://jobs.ashbyhq.com/apex-infra/1102948',
    keywords: ['devops', 'infrastructure', 'docker', 'kubernetes', 'aws', 'terraform', 'ci/cd', 'linux'],
    description: `Apex Infrastructure is seeking a DevOps Engineer to manage Kubernetes clusters and automated deployment pipelines.
Requirements:
- Strong experience with Docker container orchestration and Kubernetes deployments.
- Infrastructure-as-code using Terraform and AWS cloud services.
- Linux system administration, networking fundamentals, and shell scripting.
- Building resilient CI/CD pipelines with GitHub Actions.`,
  },
  {
    title: 'Frontend Engineer',
    company: 'PixelCraft Digital',
    location: 'San Francisco, CA',
    sourceUrl: 'https://boards.greenhouse.io/pixelcraft/jobs/7719203',
    keywords: ['frontend', 'react', 'typescript', 'nextjs', 'javascript', 'html', 'css'],
    description: `PixelCraft Digital is looking for a Frontend Engineer to create intuitive web applications.
Requirements:
- Extensive experience with React, TypeScript, Next.js, and CSS design tokens.
- Deep understanding of browser performance optimization, web vitals, and accessibility (WCAG).
- Experience collaborating with designers and integrating backend REST APIs.`,
  },
  {
    title: 'Machine Learning / AI Platform Engineer',
    company: 'NeuralFlow Labs',
    location: 'Remote',
    sourceUrl: 'https://jobs.lever.co/neuralflow/6620194',
    keywords: ['machine learning', 'ai', 'ml', 'python', 'pytorch', 'fastapi', 'docker'],
    description: `NeuralFlow Labs is hiring an ML Platform Engineer to build scalable model serving pipelines.
Requirements:
- Experience deploying machine learning and NLP models into production using FastAPI and Docker.
- Strong proficiency in Python, PyTorch or HuggingFace Transformers, and vector databases.
- Familiarity with retrieval-augmented generation (RAG) and embedding evaluation.`,
  },
  {
    title: 'Data Engineer',
    company: 'DataStream Analytics',
    location: 'Austin, TX (Remote)',
    sourceUrl: 'https://jobs.ashbyhq.com/datastream/5519204',
    keywords: ['data engineer', 'python', 'sql', 'postgresql', 'spark', 'airflow', 'kafka'],
    description: `DataStream Analytics is looking for a Data Engineer to develop robust batch and real-time streaming data pipelines.
Requirements:
- Advanced SQL and relational database tuning with PostgreSQL.
- Experience with Apache Airflow orchestration and Apache Spark data processing.
- Python programming for ETL workflows and automated schema migrations.`,
  },
];

/**
 * Deterministic MockJobSource providing repeatable test fixtures without external network calls.
 */
export class MockJobSource implements JobSource {
  public async searchJobs(
    query: JobSearchQuery,
    options?: JobSourceOptions
  ): Promise<RawJobListing[]> {
    const rawQuery = (query.query || '').toLowerCase().trim();
    const queryTokens = rawQuery.split(/[\s,+/]+/).filter((t) => t.length > 1);
    const locationQuery = (query.location || '').toLowerCase().trim();
    const limit = options?.maxResults ?? query.limit ?? 10;

    // Filter and score fixtures based on token overlap
    const scored = MOCK_FIXTURES.map((fixture) => {
      let matches = 0;
      const fixtureText = `${fixture.title} ${fixture.company} ${fixture.keywords.join(' ')} ${fixture.description}`.toLowerCase();

      for (const token of queryTokens) {
        if (fixtureText.includes(token)) {
          matches += 1;
        }
      }

      if (locationQuery && fixture.location.toLowerCase().includes(locationQuery)) {
        matches += 2;
      }

      return { fixture, matches };
    });

    // Sort by matches descending; if zero query tokens provided, return all default fixtures
    scored.sort((a, b) => b.matches - a.matches);

    const selected = (queryTokens.length > 0
      ? scored.filter((s) => s.matches > 0).map((s) => s.fixture)
      : MOCK_FIXTURES
    ).slice(0, limit);

    // If query was very specific and matched nothing, fallback to top 2 general fixtures
    const finalList = selected.length > 0 ? selected : MOCK_FIXTURES.slice(0, Math.min(2, limit));

    return finalList.map((f, idx) => {
      const cleaned = sanitizeScrapedContent(f.description);
      const urlHash = crypto.createHash('sha256').update(f.sourceUrl).digest('hex');
      const contentHash = crypto.createHash('sha256').update(cleaned).digest('hex');

      return {
        id: `mock-${idx + 1}-${urlHash.slice(0, 8)}`,
        sourceUrl: f.sourceUrl,
        title: f.title,
        company: f.company,
        location: f.location,
        rawDescription: f.description,
        cleanedText: cleaned,
        contentHash,
        urlHash,
        fetchedAt: new Date().toISOString(),
      };
    });
  }
}
