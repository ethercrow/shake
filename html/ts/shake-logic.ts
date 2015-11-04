/*jsl:option explicit*/
/*jsl:import shake-util.js*/
"use strict";

//////////////////////////////////////////////////////////////////////
// TYPES

type timestamp = int

class Trace {
    command: string;
    start: seconds;
    stop: seconds;
}

type Entry =
    {
        name: string, // Name of the thing I built
        built: timestamp, // Timestamp at which I was built
        changed: timestamp, // Timestamp at which I last changed
        depends: int[], // Which 0-based indexes I depended on (always lower than my index)
        execution: seconds, // Seconds I took to execute
        traces?: Trace[] // List of traces
    }

//////////////////////////////////////////////////////////////////////
// SUMMARY

class Summary {
    count: int = 0; // number of rules run
    countLast: int = 0 // number of rules run in the last run
    highestRun: timestamp = 0 // highest run you have seen (add 1 to get the count of runs)
    sumExecution: seconds = 0 // build time in total
    maxExecution: seconds = 0 // longest build rule
    maxExecutionName: string = "" // longest build rule
    countTrace: int = 0; countTraceLast : int = 0 // traced commands run
    sumTrace: seconds = 0; sumTraceLast: seconds = 0 // time running traced commands
    maxTrace: seconds = 0 // longest traced command
    maxTraceName: string = "" // longest trace command
    maxTraceStopLast: seconds = 0 // time the last traced command stopped
}

function /* export */ summary(dat : Entry[]) : Summary
{
    var res = new Summary();

    // Fold over dat to produce the summary
    res.count = dat.length;
    for (var i = 0; i < dat.length; i++) {
        var isLast = dat[i].built === 0;
        res.countLast += isLast ? 1 : 0;
        res.sumExecution += dat[i].execution;
        res.maxExecution = Math.max(res.maxExecution, dat[i].execution);
        if (res.maxExecution === dat[i].execution) res.maxExecutionName = dat[i].name;
        res.highestRun = Math.max(res.highestRun, dat[i].changed); // changed is always greater or equal to built
        var traces = dat[i].traces;
        if (!traces) continue;
        for (var j = 0; j < traces.length; j++) {
            var time = traces[j].stop - traces[j].start;
            res.countTrace += 1;
            res.countTraceLast += isLast ? 1 : 0;
            res.sumTrace += time;
            res.sumTraceLast += isLast ? time : 0;
            res.maxTrace = Math.max(res.maxTrace, time);
            if (res.maxTrace == time) res.maxTraceName = traces[j].command;
            res.maxTraceStopLast = Math.max(res.maxTraceStopLast, isLast ? traces[j].stop : 0);
        }
    }
    return res;
}

function /* export */ showSummary(sum : Summary) : string[]
{
    return ["This database has tracked " + (sum.highestRun + 1) + " run" + plural(sum.highestRun + 1) + "."
        , "There are " + sum.count + " rules (" + sum.countLast + " rebuilt in the last run)."
        , "Building required " + sum.countTrace + " traced commands (" + sum.countTraceLast + " in the last run)."
        , "The total (unparallelised) build time is " + showTime(sum.sumExecution) + " of which " + showTime(sum.sumTrace) + " is traced commands."
        , "The longest rule takes " + showTime(sum.maxExecution) + " (" + sum.maxExecutionName + ") and the longest traced command takes " + showTime(sum.maxTrace) + " (" + sum.maxTraceName + ")."
        , "Last run gave an average parallelism of " + (sum.maxTraceStopLast === 0 ? 0 : sum.sumTraceLast / sum.maxTraceStopLast).toFixed(2) + " times over " + showTime(sum.maxTraceStopLast) + "."
    ];
}


/////////////////////////////////////////////////////////////////////
// PREPARATION

type EntryEx = Entry &
    {
        rdeps: int[], // the 1-level reverse dependencies, index into Entry
        cost: seconds // cost if this item rebuilds
    }

class Prepare
{
    original: EntryEx[];
    summary: Summary;
    dependsOnThis: (from: int, match: string | RegExp) => boolean;
    thisDependsOn: (from: int, match: string | RegExp) => boolean;
    dependsOnThisTransitive: (from: int, match: string | RegExp) => boolean;
    thisDependsOnTransitive: (from: int, match: string | RegExp) => boolean;
}

// Mutate the input data, adding in rdeps, being the 1-level reverse dependencies
function addRdeps(dat: Entry[]): (Entry & { rdeps: int[] })[]
{
    // find the reverse dependencies
    var rdeps: MapInt<void>[] = [];
    for (var i = 0; i < dat.length; i++)
        rdeps[i] = {};
    for (var i = 0; i < dat.length; i++) {
        var deps = dat[i].depends;
        for (var j = 0, n = deps.length; j < n; j++)
            rdeps[deps[j]][i] = null;
    }

    var res: (Entry & { rdeps?: int[] })[] = dat;
    for (var i = 0; i < rdeps.length; i++) {
        var ans : number[] = [];
        for (var jj in rdeps[i])
            ans.push(Number(jj));
        res[i].rdeps = ans;
    }
    return <(Entry & { rdeps: int[] })[]>res;
}


// Given an array of indices, calculate the cost to rebuild if all of them change
// You must call addRdeps and addCost first
function calcRebuildCosts(dat: EntryEx[], xs : int[]) : seconds
{
    var seen: MapInt<void> = {};
    var tot : seconds = 0;
    function f(i : int) {
        if (i in seen) return;
        seen[i] = null;
        tot += dat[i].execution;
        var deps = dat[i].rdeps;
        for (var j = 0, n = deps.length; j < n; j++)
            f(deps[j]);
    }
    if (xs.length === 1 && dat[xs[0]].depends.length === 1)
        tot = dat[dat[xs[0]].depends[0]].cost + dat[xs[0]].execution;
    else {
        for (var i = 0, n = xs.length; i < n; i++)
            f(xs[i]);
    }
    return tot;
}

// Mutate the dat data, adding in cost, being the cost to rebuild if this item changes
function addCost(dat: (Entry & { rdeps: int[] })[]): EntryEx[]
{
    var res: (Entry & { rdeps: int[], cost?: seconds })[] = dat;
    for(var i = 0; i < dat.length; i++){
        // This call is type safe because calcRebuildCosts only ever looks at earlier items,
        // and those earlier items all have their cost filled in
        res[i].cost = calcRebuildCosts(<EntryEx[]>res, [i]);
    }
    return <EntryEx[]>res;
}

function prepare(sum: Summary, dat_: Entry[]): Prepare
{
    var dat = addCost(addRdeps(dat_));

    function toHash(r: RegExp | string): string {
        return typeof r === "string" ? "$" + r : "/" + r.source;
    }

    function findDirect(key : string) : (from : int, match : string | RegExp) => boolean {
        var c = cache(toHash, function (r) {
            var want: MapInt<void> = {};
            for (var i = 0; i < dat.length; i++) {
                if (testRegExp(r, dat[i].name)) {
                    var deps : int[] = (<any>(dat[i]))[key];
                    for (var j = 0; j < deps.length; j++)
                        want[deps[j]] = null;
                }
            }
            return want;
        });
        return function (i, r) {
            if (i in c(r))
                return true;
            else
                return false;
        };
    }

    function findTransitive(key: string, dirFwd: boolean): (from: int, match: string | RegExp) => boolean {
        var c = cache(toHash, function (r) {
            var want: MapInt<void> = {};
            for (var i = 0; i < dat.length; i++) {
                var j = dirFwd ? i : dat.length - 1 - i;
                if ((j in want) || testRegExp(r, dat[j].name)) {
                    want[j] = null;
                    const deps: int[] = (<any>(dat[j]))[key];
                    for (var k = 0; k < deps.length; k++)
                        want[deps[k]] = null;
                }
            }
            return want;
        });
        return function (i, r) { return i in c(r); };
    }

    return {
        original: dat
        , summary: sum
        , dependsOnThis: findDirect("rdeps")
        , thisDependsOn: findDirect("depends")
        , dependsOnThisTransitive: findTransitive("depends", false)
        , thisDependsOnTransitive: findTransitive("rdeps", true)
    };
}


/////////////////////////////////////////////////////////////////////
// RULES

function colorAnd(c1: color, c2: color) {
    return c1 === null ? c2 : c1 === c2 ? c1 : undefined;
}

class Result {
    items: int[];
    text: color;
    back: color;
}

function ruleFilter(dat: Prepare, query: string): MapString<Result>
{
    queryData = dat;
    var f = readQuery(query);
    var res: MapString<Result> = {};

    for (queryKey = 0; queryKey < dat.original.length; queryKey++) {
        queryVal = dat.original[queryKey];
        queryName = queryVal.name;
        queryGroup = null;
        queryBackColor = null;
        queryTextColor = null;
        if (f()) {
            if (queryGroup === null) queryGroup = queryName;
            if (!(queryGroup in res))
                res[queryGroup] = { items: [queryKey], text: queryTextColor, back: queryBackColor };
            else {
                var c = res[queryGroup];
                c.items.push(queryKey);
                c.text = colorAnd(c.text, queryTextColor);
                c.back = colorAnd(c.back, queryBackColor);
            }
        }
    }
    return res;
}

class ResultTable {
    name: string;
    count: int;
    time: seconds;
    back: color;
    text: color;
    cost: seconds;
    leaf: string | boolean; // true, false, "" (none), "both" (both)
    run: timestamp;
    unchanged: string | boolean;
}

function ruleTable(dat: Prepare, query: string): ResultTable[]
{
    function bools(x : string | boolean, y : boolean) : string | boolean {
        return x === "" ? y : x === y ? x : "both";
    }

    var res = ruleFilter(dat, query);
    var ans : ResultTable[] = [];
    for (var s in res) {
        var xs = res[s].items;
        var time = 0;
        var leaf: string | boolean = "";
        var unchanged: string | boolean = "";
        var run = 100000;
        for (var i = 0; i < xs.length; i++) {
            var x = dat.original[xs[i]];
            time += x.execution;
            leaf = bools(leaf, x.depends.length === 0);
            unchanged = bools(unchanged, x.changed !== x.built);
            run = Math.min(run, x.built);
        }
        ans.push({ name: s, count: xs.length, time: time, back: res[s].back, text: res[s].text, cost: calcRebuildCosts(dat.original, xs), leaf: leaf, run: run, unchanged: unchanged });
    }
    return ans;
}

class ResultGraph
{
    name: string;
    text: color;
    back: color;
    parents: int[];
    ancestors: int[];
}

function ruleGraph(dat : Prepare, query : string) : ResultGraph[]
{
    var res = ruleFilter(dat, query);

    var map : MapInt<int[]> = {}; // which nodes a node lives at

    // loop through each value in res, putting it into map (these are parents)
    // for any not present, descend through the dat.original list, if you aren't included, add, if you are included, skip
    var direct: MapInt<int> = {};
    var ind = -1;
    for (var s in res) {
        ind++;
        var xs = res[s].items;
        for (var i = 0; i < xs.length; i++)
            direct[xs[i]] = ind;
    }
    function getDirect(key : int) : int[] {
        return key in direct ? [direct[key]] : [];
    }

    var indirect: MapInt<int[]> = {};
    function getIndirect(key : int) : int[] {
        if (key in indirect) return indirect[key];
        if (key in direct) return [];
        var ds = dat.original[key].depends;
        const res: int[][] = [];
        for (var j = 0; j < ds.length; j++) {
            res.push(getIndirect(ds[j]));
            res.push(getDirect(ds[j]));
        }
        const res2: int[] = concatNub(res);
        indirect[key] = res2;
        return res2;
    }

    var ans : ResultGraph[] = [];
    for (var s in res) {
        var xs = res[s].items;
        var ds : int[][] = [];
        var is : int[][] = [];
        for (var i = 0; i < xs.length; i++) {
            var depends = dat.original[xs[i]].depends;
            for (var j = 0; j < depends.length; j++) {
                ds.push(getDirect(depends[j]));
                is.push(getIndirect(depends[j]));
            }
        }
        ans.push({ name: s, text: res[s].text, back: res[s].back, parents: concatNub(ds), ancestors: concatNub(is) });
    }
    return ans;
}


/////////////////////////////////////////////////////////////////////
// COMMANDS

function commandFilter(last: boolean, dat: Prepare, query: string): MapString<{ items: Trace[], text: color, back: color }>
{
    queryData = dat;
    var f = readQuery(query);
    var res: MapString<{ items: Trace[], text: color, back: color }> = {};

    for (queryKey = 0; queryKey < dat.original.length; queryKey++) {
        queryVal = dat.original[queryKey];
        if (last && queryVal.built !== 0) continue;

        var val = recordCopy(queryVal);
        var ts = queryVal.traces || [];
        queryVal = val;
        queryName = queryVal.name;
        queryBackColor = null;
        queryTextColor = null;
        for (var i = 0; i < ts.length; i++) {
            queryVal.traces = [ts[i]];
            queryGroup = null;
            if (f()) {
                if (queryGroup === null) queryGroup = ts[i].command;
                if (!(queryGroup in res))
                    res[queryGroup] = { items: [ts[i]], text: queryTextColor, back: queryBackColor };
                else {
                    var c = res[queryGroup];
                    c.items.push(ts[i]);
                    c.text = colorAnd(c.text, queryTextColor);
                    c.back = colorAnd(c.back, queryBackColor);
                }
            }
        }
    }
    return res;
}

class CommandTable {
    name: string;
    count: int;
    text: color;
    back: color;
    time: seconds;
}

function commandTable(dat: Prepare, query : string) : CommandTable[]
{
    var res = commandFilter(false, dat, query);
    var ans : CommandTable[] = [];
    for (var s in res) {
        var xs = res[s].items;
        var time = 0;
        for (var i = 0; i < xs.length; i++)
            time += xs[i].stop - xs[i].start;
        ans.push({ name: s, count: xs.length, text: res[s].text, back: res[s].back, time: time });
    }
    return ans;
}

function commandPlot(dat: Prepare, query: string, buckets: int): MapString<{ items: number[], back: color }>
{
    var end = dat.summary.maxTraceStopLast;
    var res = commandFilter(true, dat, query);
    var ans: MapString<{ items: number[], back: color }> = {};
    for (var s in res) {
        var ts = res[s].items;
        var xs : number[] = [];
        for (var i = 0; i <= buckets; i++)
            xs.push(0); // fill with 1 more element, but the last bucket will always be 0

        for (var i = 0; i < ts.length; i++) {
            var start = ts[i].start * buckets / end;
            var stop = ts[i].stop * buckets / end;

            if (Math.floor(start) === Math.floor(stop))
                xs[Math.floor(start)] += stop - start;
            else {
                for (var j = Math.ceil(start); j < Math.floor(stop); j++)
                    xs[j]++;
                xs[Math.floor(start)] += Math.ceil(start) - start;
                xs[Math.floor(stop)] += stop - Math.floor(stop);
            }
        }
        ans[s] = { items: xs.slice(0, buckets), back: res[s].back || null };
    }
    return ans;
}


/////////////////////////////////////////////////////////////////////
// ENVIRONMENT

function readQuery(query: string): () => boolean {
    if (query === "") return () => true;
    var f: () => boolean;
    try {
        f = <() => boolean>(new Function("return " + query));
    } catch (e) {
        throw { user: true, name: "parse", query: query, message: e.toString() };
    }
    return function () {
        try {
            return f();
        } catch (e) {
            throw { user: true, name: "execution", query: query, message: e.toString() };
        }
    };
}


// These are global variables mutated/queried by query execution
var queryData: Prepare = <Prepare>{};
var queryKey: int = 0;
var queryVal: EntryEx = <EntryEx>{};
var queryName: string = "";
var queryGroup: string = null;
var queryBackColor: color = null;
var queryTextColor: color = null;

function childOf(r : string | RegExp) { return queryData.dependsOnThis(queryKey, r); }
function parentOf(r: string | RegExp) { return queryData.thisDependsOn(queryKey, r); }
function ancestorOf(r: string | RegExp) { return queryData.dependsOnThisTransitive(queryKey, r); }
function descendantOf(r: string | RegExp) { return queryData.thisDependsOnTransitive(queryKey, r); }
function descendentOf(r: string | RegExp) { return descendantOf(r); }

function /* export */ group(x: string): boolean {
    if (queryGroup === null) queryGroup = "";
    queryGroup += (queryGroup === "" ? "" : " ") + x;
    return true;
}

function backColor(c: color, b = true) : boolean {
    if (b)
        queryBackColor = c;
    return true;
}

function textColor(c: color, b = true): boolean{
    if (b === undefined || b)
        queryTextColor = c;
    return true;
}

function rename(from: string, to: string = ""): boolean {
    queryName = queryName.replace(from, to);
    return true;
}

function slowestRule(): string {
    return queryData.summary.maxExecutionName;
}

function /* export */ leaf(): boolean {
    return queryVal.depends.length === 0;
}

function run(): number;
function run(i: timestamp): boolean;
function run(i? : any): any {
    if (i === undefined)
        return queryVal.built;
    else
        return queryVal.built === i;
}

function /* export */ unchanged(): boolean {
    return queryVal.changed !== queryVal.built;
}

function named(): string;
function named(r: string | RegExp, groupName?: string): boolean
function /* export */ named(r?:any, groupName?:any): any {
    if (r === undefined)
        return queryName;

    var res = execRegExp(r, queryName);
    if (res === null) {
        if (groupName === undefined)
            return false;
        else {
            group(groupName);
            return true;
        }
    }
    if (res.length !== 1) {
        for (var i = 1; i < res.length; i++)
            group(res[i]);
    }
    return true;
}

function command(): string;
function command(r: string | RegExp, groupName?: string): boolean;
function /* export */ command(r?:any, groupName?:any) : any {
    var n = (queryVal.traces || []).length;
    if (r === undefined)
        return n === 0 ? "" : queryVal.traces[0].command;

    for (var i = 0; i < n; i++) {
        var res = execRegExp(r, queryVal.traces[i].command);
        if (res === null)
            continue;
        if (res.length !== 1) {
            for (var j = 1; j < res.length; j++)
                group(res[j]);
        }
        return true;
    }
    if (groupName === undefined)
        return false;
    else {
        group(groupName);
        return true;
    }
}
