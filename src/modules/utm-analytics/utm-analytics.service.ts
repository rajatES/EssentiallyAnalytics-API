import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { BigQueryService } from '../../common/bigquery/bigquery.service';
import { TrafficDaily } from './entities/traffic-daily.entity';
import { TrafficCountryDaily } from './entities/traffic-country-daily.entity';
import { subDays, format } from 'date-fns';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { Readable } from 'stream';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(TrafficDaily)
    private readonly trafficRepo: Repository<TrafficDaily>,
    @InjectRepository(TrafficCountryDaily)
    private readonly countryRepo: Repository<TrafficCountryDaily>,
    private readonly bq: BigQueryService,
  ) {}

  // Groups by (date, utmMedium) only — keeps result set small vs the full granular query.
  async getAggregatedMetrics(startDate: string, endDate: string, filters: any) {
    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.where('a.date >= :startDate AND a.date <= :endDate', {
      startDate,
      endDate,
    });

    this.applyFilter(qb, 'utmSource', filters.utmSource);
    this.applyFilter(qb, 'utmMedium', filters.utmMedium);
    this.applyFilter(qb, 'utmCampaign', filters.utmCampaign);

    qb.select([
      "TO_CHAR(a.date, 'YYYY-MM-DD') as event_day",
      'a.utmMedium as utm_medium',
      'SUM(a.sessions) as sessions',
      'SUM(a.pageviews) as pageviews',
      'SUM(a.users) as users',
      'SUM(a.newUsers) as new_users',
      'SUM(a.recurringUsers) as recurring_users',
      'SUM(a.identifiedUsers) as identified_users',
      'SUM(a.eventCount) as event_count',
      'AVG(a.engagementRate) as engagement_rate',
    ]);

    qb.groupBy("TO_CHAR(a.date, 'YYYY-MM-DD')");
    qb.addGroupBy('a.utmMedium');
    qb.orderBy('event_day', 'ASC');
    qb.limit(50000);

    return await qb.getRawMany();
  }

  async getAvailableCampaigns(
    startDate: string,
    endDate: string,
    filters: any,
  ) {
    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.where('a.date >= :startDate AND a.date <= :endDate', {
      startDate,
      endDate,
    });
    this.applyFilter(qb, 'utmSource', filters.utmSource);

    qb.select('DISTINCT a.utmCampaign', 'utm_campaign');
    qb.orderBy('a.utmCampaign', 'ASC');
    qb.limit(500);

    return await qb.getRawMany();
  }

  async getCountryStats(startDate: string, endDate: string, filters: any) {
    const qb = this.countryRepo.createQueryBuilder('c');
    qb.where('c.date >= :startDate AND c.date <= :endDate', {
      startDate,
      endDate,
    });

    this.applyFilter(qb, 'utmSource', filters.utmSource, 'c');

    qb.select(['c.country as country', 'SUM(c.sessions) as sessions']);
    qb.groupBy('c.country');
    qb.orderBy('sessions', 'DESC');
    qb.limit(10);

    return await qb.getRawMany();
  }

  async getHeadlines(filters: { utmSource?: string | string[] } = {}) {
    const today = new Date();
    const yesterday = subDays(today, 1);
    const dayBeforeYesterday = subDays(today, 2);

    const yesterdayStr = format(yesterday, 'yyyy-MM-dd');
    const dayBeforeStr = format(dayBeforeYesterday, 'yyyy-MM-dd');
    const last7Start = format(subDays(today, 7), 'yyyy-MM-dd');
    const last7End = format(yesterday, 'yyyy-MM-dd');
    const prev7Start = format(subDays(today, 14), 'yyyy-MM-dd');
    const prev7End = format(subDays(today, 8), 'yyyy-MM-dd');

    const qb = this.trafficRepo.createQueryBuilder('a');
    qb.where('a.date >= :earliest AND a.date <= :latest', {
      earliest: prev7Start,
      latest: yesterdayStr,
    });
    this.applyFilter(qb, 'utmSource', filters.utmSource);

    qb.select([
      `SUM(CASE WHEN a.date = :yesterdayStr THEN a.sessions ELSE 0 END) as today_sessions`,
      `SUM(CASE WHEN a.date = :dayBeforeStr THEN a.sessions ELSE 0 END) as yesterday_sessions`,
      `SUM(CASE WHEN a.date = :yesterdayStr THEN a.users ELSE 0 END) as today_users`,
      `SUM(CASE WHEN a.date = :dayBeforeStr THEN a.users ELSE 0 END) as yesterday_users`,
      `SUM(CASE WHEN a.date >= :last7Start AND a.date <= :last7End THEN a.sessions ELSE 0 END) as this_week_sessions`,
      `SUM(CASE WHEN a.date >= :prev7Start AND a.date <= :prev7End THEN a.sessions ELSE 0 END) as last_week_sessions`,
      `SUM(CASE WHEN a.date >= :last7Start AND a.date <= :last7End THEN a.users ELSE 0 END) as this_week_users`,
      `SUM(CASE WHEN a.date >= :prev7Start AND a.date <= :prev7End THEN a.users ELSE 0 END) as last_week_users`,
    ]);
    qb.setParameters({
      yesterdayStr,
      dayBeforeStr,
      last7Start,
      last7End,
      prev7Start,
      prev7End,
    });

    const row = await qb.getRawOne();

    return {
      daily: {
        date: yesterdayStr,
        sessions: Number(row?.today_sessions || 0),
        prevSessions: Number(row?.yesterday_sessions || 0),
        diff: this.calculatePercentDiff(
          row?.today_sessions,
          row?.yesterday_sessions,
        ),
      },
      weekly: {
        range: `${last7Start} to ${last7End}`,
        sessions: Number(row?.this_week_sessions || 0),
        prevSessions: Number(row?.last_week_sessions || 0),
        diff: this.calculatePercentDiff(
          row?.this_week_sessions,
          row?.last_week_sessions,
        ),
      },
    };
  }

  async importLegacyData(fileBuffer: Buffer) {
    this.logger.log('Starting Legacy Data Import...');

    const fileStream = Readable.from(fileBuffer);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isHeader = true;
    const trafficMap = new Map<string, any>();
    const countryMap = new Map<string, any>();
    const BATCH_SIZE = 1500;
    let totalInserted = 0;

    const flushBatches = async () => {
      if (trafficMap.size > 0) {
        const batch = Array.from(trafficMap.values());
        for (const row of batch) delete row._engCount;
        await this.trafficRepo.upsert(batch, ['dimensionHash']);
        totalInserted += batch.length;
        trafficMap.clear();
      }
      if (countryMap.size > 0) {
        await this.countryRepo.upsert(
          Array.from(countryMap.values()),
          ['dimensionHash'],
        );
        countryMap.clear();
      }
      this.logger.log(`Upserted ${totalInserted} legacy records...`);
    };

    for await (const line of rl) {
      if (!line.trim()) continue;

      if (isHeader) {
        isHeader = false;
        continue;
      }

      const values = this.parseCSVLine(line);

      if (values.length >= 18) {
        const date = values[1]?.trim();
        const utmSource = values[2]?.trim() || '(direct)';
        const utmMedium = values[3]?.trim() || '(none)';
        const utmCampaign = values[4]?.trim() || '(not set)';
        const sessions = Number(values[5]) || 0;
        const pageviews = Number(values[6]) || 0;
        const users = Number(values[7]) || 0;
        const newUsers = Number(values[8]) || 0;
        const eventCount = Number(values[9]) || 0;
        const engagementRate = Number(values[10]) || 0;
        const country = values[11]?.trim() || 'Unknown';
        const recurringUsers = Number(values[16]) || 0;
        const identifiedUsers = Number(values[17]) || 0;

        if (!date) continue;

        this.accumulateTraffic(trafficMap, {
          date, utmSource, utmMedium, utmCampaign,
          sessions, pageviews, users, newUsers,
          recurringUsers, identifiedUsers, eventCount, engagementRate,
        });

        this.accumulateCountry(countryMap, {
          date, utmSource, country, sessions,
        });

        if (trafficMap.size >= BATCH_SIZE) {
          await flushBatches();
        }
      }
    }

    await flushBatches();

    this.logger.log(
      `Legacy Import Complete. Total inserted/updated: ${totalInserted}`,
    );
    return totalInserted;
  }

  // Fires at the same minute as the email report cron (7 PM IST). If the report
  // needs to include data from this sync, move this a few minutes earlier (e.g. '45 18 * * *').
  @Cron('0 19 * * *', { timeZone: 'Asia/Kolkata' })
  async scheduledSync() {
    await this.syncBigQueryData(false);
  }

  async syncBigQueryData(fullSync: boolean = true) {
    this.logger.log(
      fullSync
        ? 'Starting Full BQ Sync (all available data)...'
        : 'Starting Daily Analytics Sync from BigQuery...',
    );

    const query = fullSync
      ? `
      SELECT
        date, utm_source, utm_medium, utm_campaign,
        country, sessions, pageviews, users, new_users,
        recurring_users, identified_users, event_count, engagement_rate
      FROM \`bigquerytest-486307.analytics_266571177.utm_daily_metrics\`
    `
      : `
      SELECT
        date, utm_source, utm_medium, utm_campaign,
        country, sessions, pageviews, users, new_users,
        recurring_users, identified_users, event_count, engagement_rate
      FROM \`bigquerytest-486307.analytics_266571177.utm_daily_metrics\`
      WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 3 DAY)
    `;

    try {
      const stream = await this.bq.queryStream(query);
      const trafficMap = new Map<string, any>();
      const countryMap = new Map<string, any>();
      const BATCH_SIZE = 1500;
      let totalProcessed = 0;

      const flushBatches = async () => {
        if (trafficMap.size > 0) {
          const batch = Array.from(trafficMap.values());
          for (const row of batch) delete row._engCount;
          await this.trafficRepo.upsert(batch, ['dimensionHash']);
          totalProcessed += batch.length;
          trafficMap.clear();
        }
        if (countryMap.size > 0) {
          await this.countryRepo.upsert(
            Array.from(countryMap.values()),
            ['dimensionHash'],
          );
          countryMap.clear();
        }
        this.logger.log(`Upserted ${totalProcessed} traffic records...`);
      };

      for await (const row of stream) {
        const date = row.date?.value || row.date;
        const utmSource = row.utm_source || '(direct)';
        const utmMedium = row.utm_medium || '(none)';
        const utmCampaign = row.utm_campaign || '(not set)';
        const country = row.country || 'Unknown';

        const sessions = Number(row.sessions) || 0;
        const pageviews = Number(row.pageviews) || 0;
        const users = Number(row.users) || 0;
        const newUsers = Number(row.new_users) || 0;
        const recurringUsers = Number(row.recurring_users) || 0;
        const identifiedUsers = Number(row.identified_users) || 0;
        const eventCount = Number(row.event_count) || 0;
        const engagementRate = Number(row.engagement_rate) || 0;

        this.accumulateTraffic(trafficMap, {
          date, utmSource, utmMedium, utmCampaign,
          sessions, pageviews, users, newUsers,
          recurringUsers, identifiedUsers, eventCount, engagementRate,
        });

        this.accumulateCountry(countryMap, {
          date, utmSource, country, sessions,
        });

        if (trafficMap.size >= BATCH_SIZE) {
          await flushBatches();
        }
      }

      await flushBatches();
      this.logger.log('BQ Sync Complete.');
    } catch (error) {
      this.logger.error('BQ Sync Failed:', error);
    }
  }

  // Accumulates a row into the traffic_daily in-memory map, keyed by (date|source|medium|campaign).
  private accumulateTraffic(
    map: Map<string, any>,
    row: {
      date: string; utmSource: string; utmMedium: string; utmCampaign: string;
      sessions: number; pageviews: number; users: number; newUsers: number;
      recurringUsers: number; identifiedUsers: number; eventCount: number;
      engagementRate: number;
    },
  ) {
    const rawKey = `${row.date}|${row.utmSource}|${row.utmMedium}|${row.utmCampaign}`;
    const dimensionHash = crypto.createHash('md5').update(rawKey).digest('hex');

    if (!map.has(dimensionHash)) {
      map.set(dimensionHash, {
        dimensionHash,
        date: row.date,
        utmSource: row.utmSource,
        utmMedium: row.utmMedium,
        utmCampaign: row.utmCampaign,
        sessions: 0,
        pageviews: 0,
        users: 0,
        newUsers: 0,
        recurringUsers: 0,
        identifiedUsers: 0,
        eventCount: 0,
        engagementRate: 0,
        _engCount: 0,
      });
    }

    const entry = map.get(dimensionHash);
    entry.sessions += row.sessions;
    entry.pageviews += row.pageviews;
    entry.users += row.users;
    entry.newUsers += row.newUsers;
    entry.recurringUsers += row.recurringUsers;
    entry.identifiedUsers += row.identifiedUsers;
    entry.eventCount += row.eventCount;

    // Rolling average of engagement rate across accumulated rows
    if (row.engagementRate > 0) {
      entry._engCount++;
      entry.engagementRate =
        entry.engagementRate + (row.engagementRate - entry.engagementRate) / entry._engCount;
    }
  }

  // Accumulates a row into the traffic_country_daily in-memory map, keyed by (date|source|country).
  private accumulateCountry(
    map: Map<string, any>,
    row: { date: string; utmSource: string; country: string; sessions: number },
  ) {
    const rawKey = `${row.date}|${row.utmSource}|${row.country}`;
    const dimensionHash = crypto.createHash('md5').update(rawKey).digest('hex');

    if (!map.has(dimensionHash)) {
      map.set(dimensionHash, {
        dimensionHash,
        date: row.date,
        utmSource: row.utmSource,
        country: row.country,
        sessions: 0,
      });
    }

    map.get(dimensionHash).sessions += row.sessions;
  }

  private parseCSVLine(text: string): string[] {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        inQuotes = !inQuotes;
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        if (field.startsWith('"') && field.endsWith('"'))
          field = field.slice(1, -1);
        result.push(field);
        start = i + 1;
      }
    }
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"'))
      lastField = lastField.slice(1, -1);
    result.push(lastField);
    return result;
  }

  private calculatePercentDiff(current: number, previous: number) {
    if (!previous) return current > 0 ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(2));
  }

  private applyFilter(
    qb: any,
    column: string,
    value?: string | string[],
    alias: string = 'a',
  ) {
    if (!value) return;

    // Normalize Facebook/Instagram traffic variations coming from Google Analytics
    if (column === 'utmSource' && value === 'fb') {
      qb.andWhere(
        `(${alias}.${column} ILIKE '%face%' OR ${alias}.${column} ILIKE '%ig%' OR ${alias}.${column} ILIKE '%insta%' OR ${alias}.${column} IN ('fb', 'Fb'))`,
      );
      return;
    }

    if (Array.isArray(value)) {
      qb.andWhere(`${alias}.${column} IN (:...${column})`, { [column]: value });
    } else {
      qb.andWhere(`${alias}.${column} = :${column}`, { [column]: value });
    }
  }
}
