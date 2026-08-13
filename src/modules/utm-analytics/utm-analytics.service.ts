import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { BigQueryService } from '../../common/bigquery/bigquery.service';
import {
  buildPlatformSourceFilter,
  resolveTrafficPlatform,
} from '../../common/traffic-platforms';
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

    // Accumulate the whole file before writing (see flushMaps / syncBigQueryData
    // for why mid-stream flushing would undercount on repeated dimension keys).
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
      }
    }

    const totalInserted = trafficMap.size;
    await this.flushMaps(trafficMap, countryMap);

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

  // One-shot historical backfill. Rebuilds the BigQuery aggregates across the
  // entire date range (instead of a single day like the daily scheduled query),
  // then streams the whole table into Postgres. Safe to re-run — upserts are
  // keyed by dimensionHash. Intended to be removed once the backfill is done.
  async backfillFromBigQuery(startSuffix = '20260203', endSuffix?: string) {
    const end = endSuffix || format(subDays(new Date(), 1), 'yyyyMMdd');

    if (!/^\d{8}$/.test(startSuffix) || !/^\d{8}$/.test(end)) {
      throw new Error(
        `Invalid date suffix (expected YYYYMMDD): start=${startSuffix} end=${end}`,
      );
    }

    this.logger.log(`Backfill: rebuilding BQ aggregates for ${startSuffix}..${end}`);

    const viewSql = `
      CREATE OR REPLACE VIEW \`bigquerytest-486307.analytics_266571177.events_utm_base\` AS
      SELECT
        PARSE_DATE('%Y%m%d', e.event_date) AS event_day,
        e.event_timestamp,
        e.user_pseudo_id,
        e.user_id,
        e.event_name,
        e.geo.country,
        e.geo.city,
        e.device.category AS device_category,
        (SELECT value.string_value FROM UNNEST(e.user_properties) WHERE key = 'gender' LIMIT 1) AS user_gender,
        (SELECT value.string_value FROM UNNEST(e.user_properties) WHERE key = 'age_bracket' LIMIT 1) AS user_age,
        COALESCE(p.source, p.utm_source, '(direct)') AS utm_source,
        COALESCE(p.medium, p.utm_medium, '(none)') AS utm_medium,
        COALESCE(p.campaign, p.utm_campaign, '(not set)') AS utm_campaign,
        p.ga_session_id,
        p.ga_session_number,
        p.session_engaged
      FROM \`bigquerytest-486307.analytics_266571177.events_2*\` e
      LEFT JOIN (
        SELECT
          event_timestamp,
          user_pseudo_id,
          MAX(IF(key = 'source', value.string_value, NULL)) AS source,
          MAX(IF(key = 'utm_source', value.string_value, NULL)) AS utm_source,
          MAX(IF(key = 'medium', value.string_value, NULL)) AS medium,
          MAX(IF(key = 'utm_medium', value.string_value, NULL)) AS utm_medium,
          MAX(IF(key = 'campaign', value.string_value, NULL)) AS campaign,
          MAX(IF(key = 'utm_campaign', value.string_value, NULL)) AS utm_campaign,
          MAX(IF(key = 'ga_session_id', value.int_value, NULL)) AS ga_session_id,
          MAX(IF(key = 'ga_session_number', value.int_value, NULL)) AS ga_session_number,
          MAX(IF(key = 'session_engaged', value.string_value, NULL)) AS session_engaged
        FROM \`bigquerytest-486307.analytics_266571177.events_2*\`,
             UNNEST(event_params)
        WHERE event_name IN ('page_view', 'session_start', 'first_visit', 'user_engagement', 'user-logged-in')
          AND CONCAT('2', _TABLE_SUFFIX) BETWEEN '${startSuffix}' AND '${end}'
        GROUP BY event_timestamp, user_pseudo_id
      ) p
      ON e.event_timestamp = p.event_timestamp
      AND e.user_pseudo_id = p.user_pseudo_id
      WHERE p.ga_session_id IS NOT NULL
        AND CONCAT('2', e._TABLE_SUFFIX) BETWEEN '${startSuffix}' AND '${end}';
    `;

    await this.bq.query(viewSql);
    this.logger.log('Backfill: base view rebuilt across range, building metrics table...');

    const tableSql = `
      CREATE OR REPLACE TABLE \`bigquerytest-486307.analytics_266571177.utm_daily_metrics\` AS
      WITH sessionized AS (
        SELECT
          event_day,
          utm_source,
          utm_medium,
          utm_campaign,
          MAX(country) AS country,
          MAX(city) AS city,
          MAX(device_category) AS device_category,
          MAX(user_gender) AS user_gender,
          MAX(user_age) AS user_age,
          CONCAT(user_pseudo_id, '-', CAST(ga_session_id AS STRING)) AS session_id,
          user_pseudo_id,
          MAX(user_id) AS user_id,
          MAX(IF(event_name = 'first_visit', 1, 0)) AS is_new_user,
          MAX(IF(ga_session_number > 1, 1, 0)) AS is_recurring_user,
          MAX(IF(session_engaged = '1', 1, 0)) AS is_engaged,
          COUNTIF(event_name = 'page_view') AS pageviews,
          COUNT(*) AS event_count
        FROM \`bigquerytest-486307.analytics_266571177.events_utm_base\`
        GROUP BY 1,2,3,4, 10,11
      )
      SELECT
        event_day AS date,
        utm_source,
        utm_medium,
        utm_campaign,
        country,
        city,
        device_category,
        COALESCE(user_gender, 'Unknown') AS user_gender,
        COALESCE(user_age, 'Unknown') AS user_age,
        COUNT(DISTINCT session_id) AS sessions,
        SUM(pageviews) AS pageviews,
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(DISTINCT IF(is_new_user = 1, user_pseudo_id, NULL)) AS new_users,
        COUNT(DISTINCT IF(is_recurring_user = 1, user_pseudo_id, NULL)) AS recurring_users,
        COUNT(DISTINCT user_id) AS identified_users,
        SUM(event_count) AS event_count,
        SAFE_DIVIDE(
          COUNT(DISTINCT IF(is_engaged = 1, session_id, NULL)),
          COUNT(DISTINCT session_id)
        ) AS engagement_rate
      FROM sessionized
      GROUP BY 1,2,3,4, 5,6,7,8,9;
    `;

    await this.bq.query(tableSql);
    this.logger.log('Backfill: metrics table rebuilt, syncing into Postgres...');

    await this.syncBigQueryData(true);
    this.logger.log(`Backfill complete for ${startSuffix}..${end}`);

    return { startSuffix, endSuffix: end };
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

      // Accumulate the ENTIRE result set before writing. The source rows are not
      // ordered by our dimension key, so a single (date|source|medium|campaign)
      // is spread across many granular rows throughout the stream. Flushing mid-stream
      // and clearing the map would make a later upsert overwrite (not add to) an
      // already-written row, undercounting every metric. Pre-aggregation keeps the
      // key count small, so the full map fits in memory; we write once at the end.
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
      }

      await this.flushMaps(trafficMap, countryMap);
      this.logger.log('BQ Sync Complete.');
    } catch (error) {
      this.logger.error('BQ Sync Failed:', error);
    }
  }

  // Writes the fully-accumulated maps to Postgres in a single pass. Each key
  // appears exactly once here, so chunking (to stay under the bind-parameter
  // limit) is safe — no key is split across two upserts.
  private async flushMaps(
    trafficMap: Map<string, any>,
    countryMap: Map<string, any>,
  ) {
    const CHUNK = 1000;

    const trafficRows = Array.from(trafficMap.values());
    for (const row of trafficRows) delete row._engCount;
    for (let i = 0; i < trafficRows.length; i += CHUNK) {
      await this.trafficRepo.upsert(
        trafficRows.slice(i, i + CHUNK),
        ['dimensionHash'],
      );
    }

    const countryRows = Array.from(countryMap.values());
    for (let i = 0; i < countryRows.length; i += CHUNK) {
      await this.countryRepo.upsert(
        countryRows.slice(i, i + CHUNK),
        ['dimensionHash'],
      );
    }

    this.logger.log(
      `Upserted ${trafficRows.length} traffic + ${countryRows.length} country records.`,
    );
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

    // utmSource is a platform selector, not a literal value: Google Analytics
    // reports each platform under many spellings, so resolve it through the
    // shared registry (see common/traffic-platforms.ts). Anything that isn't a
    // known platform key falls through to plain equality below.
    if (column === 'utmSource') {
      const platform = resolveTrafficPlatform(value);
      if (platform) {
        const { sql, params } = buildPlatformSourceFilter(
          platform,
          alias,
          column,
          `plat_${alias}`,
        );
        qb.andWhere(sql, params);
        return;
      }
    }

    if (Array.isArray(value)) {
      qb.andWhere(`${alias}.${column} IN (:...${column})`, { [column]: value });
    } else {
      qb.andWhere(`${alias}.${column} = :${column}`, { [column]: value });
    }
  }
}
