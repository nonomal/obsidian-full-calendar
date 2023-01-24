import { TFile } from "obsidian";
import { Calendar } from "../calendars/Calendar";
import { EventLocation, OFCEvent } from "../types";

interface Identifier {
    id: string;
}

class Path implements Identifier {
    id: string;
    constructor(file: { path: string }) {
        this.id = file.path;
    }
}

class EventID implements Identifier {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
}

class OneToMany<T extends Identifier, FK extends Identifier> {
    private foreign: Map<string, string> = new Map();
    private related: Map<string, Set<string>> = new Map();

    clear() {
        this.foreign.clear();
        this.related.clear();
    }

    add(one: T, many: FK) {
        this.foreign.set(many.id, one.id);
        let related = this.related.get(one.id);
        if (!related) {
            related = new Set();
            this.related.set(one.id, related);
        }
        related.add(many.id);
    }

    delete(many: FK) {
        const oneId = this.foreign.get(many.id);
        if (!oneId) {
            return;
        }
        this.foreign.delete(many.id);
        const related = this.related.get(oneId);
        if (!related) {
            throw new Error(
                `Unreachable: state: relation <${oneId}> exists in the foreign map but not the related map.`
            );
        }
        related.delete(many.id);
    }

    getBy(key: T): Set<string> {
        const related = this.related.get(key.id);
        if (!related) {
            return new Set();
        }
        return new Set(related);
    }

    getRelated(key: FK): string | null {
        return this.foreign.get(key.id) || null;
    }

    renameKey(oldKey: T, newKey: T) {
        const related = this.related.get(oldKey.id);
        if (!related) {
            throw new Error(`Key does not exist in map: ${related}`);
        }
        this.related.delete(oldKey.id);
        this.related.set(newKey.id, related);
    }

    get numEntries(): number {
        return this.foreign.size;
    }

    get relatedCount(): number {
        return [...this.related.values()].filter((s) => s.size > 0).length;
    }

    get groupByRelated(): Map<string, string[]> {
        const result: Map<string, string[]> = new Map();
        for (const [key, values] of this.related.entries()) {
            result.set(key, [...values.values()]);
        }
        return result;
    }
}

export type EventPathLocation = {
    path: string;
    lineNumber: number | undefined;
};

export type StoredEvent = {
    id: string;
    event: OFCEvent;
    location: EventPathLocation | null;
    calendarId: string;
};

type AddEventProps = {
    calendar: Calendar;
    location: EventLocation | null;
    id: string;
    event: OFCEvent;
};

type EventDetails = Omit<AddEventProps, "location" | "calendar"> & {
    location: EventPathLocation | null;
    calendarId: string;
};

type FileObj = { path: string };

/**
 * Class that stores events by their ID as the primary key, with secondary "indexes"
 * by calendar and file. You can look up events by what calendar they belong to, as
 * well as what file their source lives in.
 */
// TODO: Add a position index, just stored as a line number for now. This will be one-to-one.
export default class EventStore {
    private store: Map<string, OFCEvent> = new Map();

    private calendarIndex = new OneToMany<Calendar, EventID>();

    private pathIndex = new OneToMany<Path, EventID>();
    private lineNumbers: Map<string, number> = new Map();

    clear() {
        this.store.clear();
        this.calendarIndex.clear();
        this.pathIndex.clear();
        this.lineNumbers.clear();
    }

    get fileCount() {
        return this.pathIndex.relatedCount;
    }

    get calendarCount() {
        return this.calendarIndex.relatedCount;
    }

    get eventCount() {
        return this.store.size;
    }

    private fetch(ids: string[] | Set<string>): StoredEvent[] {
        const result: StoredEvent[] = [];
        ids.forEach((id) => {
            const event = this.store.get(id);
            if (!event) {
                return;
            }
            const path = this.pathIndex.getRelated(new EventID(id));
            let lineNumber: number | undefined = undefined;
            if (path) {
                lineNumber = this.lineNumbers.get(id);
            }
            const location = path ? { path, lineNumber } : null;
            const calendarId = this.calendarIndex.getRelated(new EventID(id));
            if (!calendarId) {
                throw new Error(
                    `Event with id ${id} does not have an associated calendar.`
                );
            }
            result.push({ id, event, location, calendarId });
        });
        return result;
    }

    add({ calendar, location, id, event }: AddEventProps) {
        if (this.store.has(id)) {
            throw new Error(
                "Event with given ID already exists in the EventStore."
            );
        }

        console.log("adding event", { id, event, location });

        this.store.set(id, event);
        this.calendarIndex.add(calendar, new EventID(id));
        if (location) {
            const { file, lineNumber } = location;
            console.log("adding event in file:", file.path);
            this.pathIndex.add(new Path(file), new EventID(id));
            if (lineNumber) {
                this.lineNumbers.set(id, lineNumber);
            }
        }
    }

    delete(id: string): OFCEvent | null {
        const event = this.store.get(id);
        if (!event) {
            return null;
        }
        console.log("deleting event", { id, event });

        this.calendarIndex.delete(new EventID(id));
        this.pathIndex.delete(new EventID(id));
        this.lineNumbers.delete(id);
        this.store.delete(id);
        return event;
    }

    getEventById(id: string): OFCEvent | null {
        return this.store.get(id) || null;
    }

    getEventsInFile(file: FileObj): StoredEvent[] {
        return this.fetch(this.pathIndex.getBy(new Path(file)));
    }

    deleteEventsAtPath(path: string): Set<string> {
        const eventIds = this.pathIndex.getBy(new Path({ path }));
        eventIds.forEach((id) => this.delete(id));
        return eventIds;
    }

    renameFileForEvents(oldPath: string, newPath: string) {
        this.pathIndex.renameKey(
            new Path({ path: oldPath }),
            new Path({ path: newPath })
        );
    }

    getEventsInCalendar(calendar: Calendar): StoredEvent[] {
        return this.fetch(this.calendarIndex.getBy(calendar));
    }

    getEventsInFileAndCalendar(
        file: FileObj,
        calendar: Calendar
    ): StoredEvent[] {
        const inFile = this.pathIndex.getBy(new Path(file));
        const inCalendar = this.calendarIndex.getBy(calendar);
        return this.fetch([...inFile].filter((id) => inCalendar.has(id)));
    }

    getCalendarIdForEventId(id: string): string | null {
        return this.calendarIndex.getRelated(new EventID(id));
    }

    getFilePathForEventId(id: string): string | null {
        return this.pathIndex.getRelated(new EventID(id));
    }

    get eventsByCalendar(): Map<string, StoredEvent[]> {
        const result = new Map();
        for (const [k, vs] of this.calendarIndex.groupByRelated) {
            result.set(k, this.fetch(vs));
        }
        return result;
    }

    getEventDetails(eventId: string): EventDetails | null {
        const event = this.getEventById(eventId);
        const calendarId = this.getCalendarIdForEventId(eventId);
        if (!event || !calendarId) {
            return null;
        }

        const path = this.getFilePathForEventId(eventId);
        const lineNumber = this.lineNumbers.get(eventId);
        const location = path ? { path, lineNumber } : null;
        return { id: eventId, event, calendarId, location };
    }
}