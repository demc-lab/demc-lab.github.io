(() => {
    const canvas = document.getElementById("home-network-viz");
    if (!canvas) {
        return;
    }

    const ctx = canvas.getContext("2d");
    const parent = canvas.parentElement;

    const HOVER_DELAY_MS = 750;
    const RESET_DURATION_MS = 2000;
    const CONTAGION_STEP_MS = 280;
    const HOMOPHILY_BIAS = 0.7;
    const CLOSURE_BIAS = 0.7;
    const BASE_INFECTED_RATE = 0.13;
    const EDGE_CYCLE_FADE_MS = 700;
    const MAX_DPR = 2;
    const GRAY_10 = 242;
    const GRAY_90 = 38;
    const GLOW_CORE_RGB = { r: 69, g: 221, b: 18 };
    const GLOW_OUTER_RGB = { r: 98, g: 244, b: 12 };
    const ATTRACT_LOCK_MS = 180;
    const ATTRACT_SWITCH_COOLDOWN_MS = 160;
    const ATTRACT_SWITCH_RATIO = 0.7;

    const isSmallScreen = window.matchMedia("(max-width: 780px)").matches;
    const NODE_COUNT = isSmallScreen ? 52 : 84;
    const EDGE_SLOT_COUNT = Math.round(NODE_COUNT * 1.55);

    const nodes = [];
    const edges = [];
    const baseInfected = new Array(NODE_COUNT).fill(false);
    const displayInfection = new Float32Array(NODE_COUNT);
    const targetInfection = new Float32Array(NODE_COUNT);

    const pointer = {
        inside: false,
        x: 0,
        y: 0
    };

    let hoveredNode = -1;
    let hoveredSince = 0;
    let hoverContagionStarted = false;

    let contagionState = null;
    let resetState = null;
    let lastFrame = performance.now();
    let width = 0;
    let height = 0;
    let dpr = 1;
    let attractLockIndex = -1;
    let attractLockUntil = 0;
    let attractLastSwitchAt = 0;

    function randomRange(min, max) {
        return min + Math.random() * (max - min);
    }

    function pickRandom(items) {
        return items[Math.floor(Math.random() * items.length)];
    }

    function createNodes() {
        nodes.length = 0;
        const padding = Math.min(width, height) * 0.08;

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const group = Math.random() < 0.5 ? 0 : 1;
            const speedScale = randomRange(0.7, 1.2);

            nodes.push({
                id: i,
                group,
                x: randomRange(padding, width - padding),
                y: randomRange(padding, height - padding),
                vx: randomRange(-0.018, 0.018) * speedScale,
                vy: randomRange(-0.018, 0.018) * speedScale,
                driftPhase: randomRange(0, Math.PI * 2),
                alphaPhase: randomRange(0, Math.PI * 2),
                radius: randomRange(3.0, 4.8)
            });
        }
    }

    function seedBaseInfection() {
        baseInfected.fill(false);

        const targetCount = Math.max(1, Math.round(NODE_COUNT * BASE_INFECTED_RATE));
        const picks = Array.from({ length: NODE_COUNT }, (_, i) => i)
            .sort(() => Math.random() - 0.5)
            .slice(0, targetCount);

        for (const idx of picks) {
            baseInfected[idx] = true;
        }

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const baseValue = baseInfected[i] ? 1 : 0;
            displayInfection[i] = baseValue;
            targetInfection[i] = baseValue;
        }
    }

    function hasEdge(a, b, skipIndex = -1) {
        for (let i = 0; i < edges.length; i += 1) {
            if (i === skipIndex) {
                continue;
            }
            const e = edges[i];
            if (!e) {
                continue;
            }
            if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
                return true;
            }
        }
        return false;
    }

    function buildStaticAdjacency(skipIndex = -1) {
        const adjacency = Array.from({ length: NODE_COUNT }, () => new Set());
        for (let i = 0; i < edges.length; i += 1) {
            if (i === skipIndex) {
                continue;
            }
            const edge = edges[i];
            if (!edge) {
                continue;
            }
            adjacency[edge.a].add(edge.b);
            adjacency[edge.b].add(edge.a);
        }
        return adjacency;
    }

    function chooseEdgeEndpoints(skipIndex = -1) {
        const adjacency = buildStaticAdjacency(skipIndex);

        for (let attempt = 0; attempt < 40; attempt += 1) {
            const a = Math.floor(Math.random() * NODE_COUNT);
            const preferHomophily = Math.random() < HOMOPHILY_BIAS;
            const targetGroup = preferHomophily ? nodes[a].group : 1 - nodes[a].group;
            const preferClosure = Math.random() < CLOSURE_BIAS;

            const candidatePool = [];
            for (let j = 0; j < NODE_COUNT; j += 1) {
                if (j === a || hasEdge(a, j, skipIndex)) {
                    continue;
                }
                if (nodes[j].group === targetGroup) {
                    candidatePool.push(j);
                }
            }

            if (candidatePool.length === 0) {
                continue;
            }

            let b = null;

            if (preferClosure) {
                const closurePool = [];
                const neighbors = adjacency[a];
                for (const n of neighbors) {
                    for (const candidate of adjacency[n]) {
                        if (
                            candidate !== a &&
                            !neighbors.has(candidate) &&
                            !hasEdge(a, candidate, skipIndex) &&
                            nodes[candidate].group === targetGroup
                        ) {
                            closurePool.push(candidate);
                        }
                    }
                }
                if (closurePool.length > 0) {
                    b = pickRandom(closurePool);
                }
            }

            if (b === null) {
                b = pickRandom(candidatePool);
            }

            if (b !== null && b !== a) {
                return [a, b];
            }
        }

        for (let a = 0; a < NODE_COUNT; a += 1) {
            for (let b = a + 1; b < NODE_COUNT; b += 1) {
                if (!hasEdge(a, b, skipIndex)) {
                    return [a, b];
                }
            }
        }
        return [0, 1];
    }

    function resetEdge(edge, now, skipIndex = -1) {
        const [a, b] = chooseEdgeEndpoints(skipIndex);
        edge.a = a;
        edge.b = b;
        edge.onDuration = randomRange(22000, 42000);
        edge.offDuration = randomRange(9000, 18000);
        edge.phaseOffset = randomRange(0, edge.onDuration + edge.offDuration);
        edge.rewireAt = now + randomRange(48000, 90000);
    }

    function buildEdges(now) {
        edges.length = 0;
        for (let i = 0; i < EDGE_SLOT_COUNT; i += 1) {
            const edge = {};
            edges.push(edge);
            resetEdge(edge, now, i);
        }
    }

    function edgeVisibility(edge, now) {
        const cycle = edge.onDuration + edge.offDuration;
        const cyclePos = (now + edge.phaseOffset) % cycle;
        if (cyclePos >= edge.onDuration) {
            return 0;
        }
        const nearStart = Math.min(1, cyclePos / EDGE_CYCLE_FADE_MS);
        const nearEnd = Math.min(1, (edge.onDuration - cyclePos) / EDGE_CYCLE_FADE_MS);
        return Math.max(0, Math.min(1, Math.min(nearStart, nearEnd)));
    }

    function currentActiveAdjacency(now) {
        const adjacency = Array.from({ length: NODE_COUNT }, () => new Set());
        for (const edge of edges) {
            if (edgeVisibility(edge, now) > 0.35) {
                adjacency[edge.a].add(edge.b);
                adjacency[edge.b].add(edge.a);
            }
        }
        return adjacency;
    }

    function countSharedNeighbors(adjacency, a, b) {
        const neighborsA = adjacency[a];
        const neighborsB = adjacency[b];
        if (neighborsA.size === 0 || neighborsB.size === 0) {
            return 0;
        }

        let small = neighborsA;
        let large = neighborsB;
        if (neighborsA.size > neighborsB.size) {
            small = neighborsB;
            large = neighborsA;
        }

        let shared = 0;
        for (const n of small) {
            if (large.has(n)) {
                shared += 1;
            }
        }
        return shared;
    }

    function applyResetTargets(now) {
        if (!resetState) {
            return;
        }

        const elapsed = now - resetState.startedAt;
        const t = Math.min(1, elapsed / RESET_DURATION_MS);
        const eased = 1 - Math.pow(1 - t, 3);

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const baseline = baseInfected[i] ? 1 : 0;
            targetInfection[i] = resetState.from[i] + (baseline - resetState.from[i]) * eased;
        }

        if (t >= 1) {
            for (let i = 0; i < NODE_COUNT; i += 1) {
                targetInfection[i] = baseInfected[i] ? 1 : 0;
            }
            resetState = null;
        }
    }

    function clearToBaseTargets() {
        for (let i = 0; i < NODE_COUNT; i += 1) {
            targetInfection[i] = baseInfected[i] ? 1 : 0;
        }
    }

    function beginReset(now) {
        const snapshot = new Float32Array(NODE_COUNT);
        for (let i = 0; i < NODE_COUNT; i += 1) {
            snapshot[i] = targetInfection[i];
        }
        resetState = {
            startedAt: now,
            from: snapshot
        };
    }

    function buildHoverTargets(hoverIndex) {
        clearToBaseTargets();
        if (hoverIndex >= 0) {
            targetInfection[hoverIndex] = 1;
        }
    }

    function startContagion(now) {
        if (hoveredNode < 0) {
            return;
        }

        if (baseInfected[hoveredNode]) {
            return;
        }

        const adjacency = currentActiveAdjacency(now);
        const neighbors = adjacency[hoveredNode];

        let hasInfectedNeighbor = false;
        for (const n of neighbors) {
            if (baseInfected[n]) {
                hasInfectedNeighbor = true;
                break;
            }
        }

        if (!hasInfectedNeighbor) {
            return;
        }

        const infected = new Set();
        for (let i = 0; i < NODE_COUNT; i += 1) {
            if (baseInfected[i]) {
                infected.add(i);
            }
        }
        infected.add(hoveredNode);

        contagionState = {
            infected,
            nextStepAt: now + CONTAGION_STEP_MS
        };
    }

    function stepContagion(now) {
        if (!contagionState || now < contagionState.nextStepAt) {
            return;
        }

        const { infected } = contagionState;
        const adjacency = currentActiveAdjacency(now);
        const newlyInfected = [];

        for (let i = 0; i < NODE_COUNT; i += 1) {
            if (infected.has(i)) {
                continue;
            }
            let infectedNeighbors = 0;
            for (const n of adjacency[i]) {
                if (infected.has(n)) {
                    infectedNeighbors += 1;
                    if (infectedNeighbors >= 2) {
                        break;
                    }
                }
            }
            if (infectedNeighbors >= 2) {
                newlyInfected.push(i);
            }
        }

        for (const idx of newlyInfected) {
            infected.add(idx);
        }

        clearToBaseTargets();
        for (const idx of infected) {
            targetInfection[idx] = 1;
        }

        if (infected.size >= NODE_COUNT) {
            contagionState = null;
            return;
        }

        contagionState.nextStepAt = now + CONTAGION_STEP_MS;
    }

    function findHoveredNode() {
        if (!pointer.inside) {
            return -1;
        }
        const radius = 16;
        const radiusSq = radius * radius;
        let best = -1;
        let bestSq = radiusSq;

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const node = nodes[i];
            const dx = node.x - pointer.x;
            const dy = node.y - pointer.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestSq) {
                bestSq = distSq;
                best = i;
            }
        }
        return best;
    }

    function updateHoverState(now) {
        const nextHover = findHoveredNode();
        if (nextHover !== hoveredNode) {
            const hadActiveInteraction = hoveredNode >= 0 || contagionState !== null;
            if (hadActiveInteraction) {
                beginReset(now);
            }
            hoveredNode = nextHover;
            hoveredSince = now;
            hoverContagionStarted = false;
            contagionState = null;

            if (hoveredNode >= 0 && !hadActiveInteraction) {
                resetState = null;
                buildHoverTargets(hoveredNode);
            }
            return;
        }

        if (contagionState) {
            clearToBaseTargets();
            for (const idx of contagionState.infected) {
                targetInfection[idx] = 1;
            }
            if (hoveredNode >= 0) {
                targetInfection[hoveredNode] = 1;
            }
            return;
        }

        if (resetState) {
            return;
        }

        if (hoveredNode >= 0) {
            buildHoverTargets(hoveredNode);
            if (!hoverContagionStarted && now - hoveredSince >= HOVER_DELAY_MS) {
                hoverContagionStarted = true;
                startContagion(now);
            }
        } else if (!resetState) {
            clearToBaseTargets();
        }
    }

    function updateNodeMotion(dt, now) {
        const padding = Math.min(width, height) * 0.065;
        const attractionRadius = Math.min(width, height) * 0.22;
        const attractionRadiusSq = attractionRadius * attractionRadius;
        const dtScale = Math.min(1.35, dt / 16.67);
        const linkBaseDistance = Math.min(width, height) * 0.185;

        let candidateIndex = -1;
        let candidateDistSq = Infinity;
        let attractIndex = -1;

        if (hoveredNode >= 0) {
            candidateIndex = hoveredNode;
        } else if (pointer.inside) {
            for (let i = 0; i < NODE_COUNT; i += 1) {
                const node = nodes[i];
                const dx = node.x - pointer.x;
                const dy = node.y - pointer.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < candidateDistSq) {
                    candidateDistSq = distSq;
                    candidateIndex = i;
                }
            }

            if (candidateDistSq > attractionRadiusSq) {
                candidateIndex = -1;
            }
        }

        if (candidateIndex >= 0) {
            if (attractLockIndex < 0) {
                attractLockIndex = candidateIndex;
                attractLastSwitchAt = now;
            } else if (candidateIndex !== attractLockIndex) {
                const lockNode = nodes[attractLockIndex];
                const lockDx = lockNode.x - pointer.x;
                const lockDy = lockNode.y - pointer.y;
                const lockDistSq = lockDx * lockDx + lockDy * lockDy;
                const cooldownPassed = now - attractLastSwitchAt >= ATTRACT_SWITCH_COOLDOWN_MS;
                const candidateClearlyCloser = candidateDistSq < lockDistSq * ATTRACT_SWITCH_RATIO;

                if (cooldownPassed && candidateClearlyCloser) {
                    attractLockIndex = candidateIndex;
                    attractLastSwitchAt = now;
                }
            }
            attractLockUntil = now + ATTRACT_LOCK_MS;
        }

        if (attractLockIndex >= 0 && (pointer.inside || now <= attractLockUntil)) {
            attractIndex = attractLockIndex;
        } else {
            attractLockIndex = -1;
        }

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const node = nodes[i];

            const slowWaveX = Math.sin(now * 0.000085 + node.driftPhase) * 0.0014 * dt;
            const slowWaveY = Math.cos(now * 0.00008 + node.driftPhase * 1.17) * 0.0011 * dt;

            node.x += node.vx * dt + slowWaveX;
            node.y += node.vy * dt + slowWaveY;

            if (node.x < padding || node.x > width - padding) {
                node.vx *= -1;
                node.x = Math.max(padding, Math.min(width - padding, node.x));
            }
            if (node.y < padding || node.y > height - padding) {
                node.vy *= -1;
                node.y = Math.max(padding, Math.min(height - padding, node.y));
            }

            if (i === attractIndex) {
                const dxToPointer = pointer.x - node.x;
                const dyToPointer = pointer.y - node.y;
                const distSq = dxToPointer * dxToPointer + dyToPointer * dyToPointer;
                if (distSq > 0.5) {
                    const dist = Math.sqrt(distSq);
                    const followFactor = hoveredNode >= 0 ? 0.07 : 0.048;
                    const maxStep = hoveredNode >= 0 ? 0.82 : 0.56;
                    const easedStep = dist * followFactor * dtScale;
                    const step = Math.min(maxStep * dtScale, easedStep);
                    node.x += (dxToPointer / dist) * step;
                    node.y += (dyToPointer / dist) * step;
                }
                node.vx *= 0.9;
                node.vy *= 0.9;
            }

            node.vx *= 0.9993;
            node.vy *= 0.9993;
        }

        const activeAdjacency = Array.from({ length: NODE_COUNT }, () => new Set());
        const activeLinks = [];
        for (const edge of edges) {
            const vis = edgeVisibility(edge, now);
            if (vis <= 0.24) {
                continue;
            }
            activeAdjacency[edge.a].add(edge.b);
            activeAdjacency[edge.b].add(edge.a);
            activeLinks.push({ a: edge.a, b: edge.b, vis });
        }

        for (const link of activeLinks) {
            const nodeA = nodes[link.a];
            const nodeB = nodes[link.b];
            const dx = nodeB.x - nodeA.x;
            const dy = nodeB.y - nodeA.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < 0.0001) {
                continue;
            }
            const dist = Math.sqrt(distSq);

            const degA = activeAdjacency[link.a].size;
            const degB = activeAdjacency[link.b].size;
            const shared = countSharedNeighbors(activeAdjacency, link.a, link.b);

            const localDensityBoost = Math.min(0.2, shared * 0.06 + Math.max(0, Math.min(degA, degB) - 1) * 0.02);
            const densityWeight = 1 + localDensityBoost;
            const sharedShortening = Math.min(0.06, shared * 0.02 + Math.max(0, Math.min(degA, degB) - 1) * 0.006);
            const targetDistance = linkBaseDistance * (1 - sharedShortening);
            const stretch = dist - targetDistance;

            if (stretch <= 0) {
                continue;
            }

            const maxAdjust = 0.09 * dtScale;
            const adjust = Math.min(maxAdjust, stretch * 0.011 * link.vis * densityWeight * dtScale);
            const ux = dx / dist;
            const uy = dy / dist;
            const halfAdjustX = ux * adjust * 0.5;
            const halfAdjustY = uy * adjust * 0.5;

            nodeA.x += halfAdjustX;
            nodeA.y += halfAdjustY;
            nodeB.x -= halfAdjustX;
            nodeB.y -= halfAdjustY;

            nodeA.x = Math.max(padding, Math.min(width - padding, nodeA.x));
            nodeA.y = Math.max(padding, Math.min(height - padding, nodeA.y));
            nodeB.x = Math.max(padding, Math.min(width - padding, nodeB.x));
            nodeB.y = Math.max(padding, Math.min(height - padding, nodeB.y));
        }

        const repulsionRadius = Math.min(width, height) * 0.42;
        const repulsionRadiusSq = repulsionRadius * repulsionRadius;
        for (let i = 0; i < NODE_COUNT; i += 1) {
            for (let j = i + 1; j < NODE_COUNT; j += 1) {
                const nodeA = nodes[i];
                const nodeB = nodes[j];
                const dx = nodeB.x - nodeA.x;
                const dy = nodeB.y - nodeA.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < 0.0001 || distSq >= repulsionRadiusSq) {
                    continue;
                }

                const dist = Math.sqrt(distSq);
                const closeness = 1 - dist / repulsionRadius;
                let push = closeness * closeness * 0.028 * dtScale;
                if (activeAdjacency[i].has(j)) {
                    push *= 0.44;
                }
                push = Math.min(0.055 * dtScale, push);

                const ux = dx / dist;
                const uy = dy / dist;
                const halfPushX = ux * push * 0.5;
                const halfPushY = uy * push * 0.5;

                nodeA.x -= halfPushX;
                nodeA.y -= halfPushY;
                nodeB.x += halfPushX;
                nodeB.y += halfPushY;
            }
        }

        const minSeparation = Math.min(width, height) * 0.022;
        const minSeparationSq = minSeparation * minSeparation;
        for (let i = 0; i < NODE_COUNT; i += 1) {
            for (let j = i + 1; j < NODE_COUNT; j += 1) {
                const nodeA = nodes[i];
                const nodeB = nodes[j];
                const dx = nodeB.x - nodeA.x;
                const dy = nodeB.y - nodeA.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < 0.0001 || distSq >= minSeparationSq) {
                    continue;
                }
                const dist = Math.sqrt(distSq);
                const overlap = minSeparation - dist;
                const push = Math.min(0.1 * dtScale, overlap * 0.042 * dtScale);
                const ux = dx / dist;
                const uy = dy / dist;
                const halfPushX = ux * push * 0.5;
                const halfPushY = uy * push * 0.5;

                nodeA.x -= halfPushX;
                nodeA.y -= halfPushY;
                nodeB.x += halfPushX;
                nodeB.y += halfPushY;
            }
        }

        for (const node of nodes) {
            node.x = Math.max(padding, Math.min(width - padding, node.x));
            node.y = Math.max(padding, Math.min(height - padding, node.y));
        }
    }

    function animateInfection(dt) {
        const blend = Math.min(1, dt / 260);
        for (let i = 0; i < NODE_COUNT; i += 1) {
            displayInfection[i] += (targetInfection[i] - displayInfection[i]) * blend;
        }
    }

    function draw(now) {
        ctx.clearRect(0, 0, width, height);
        const hoverNeighborWeight = hoveredNode >= 0 ? new Float32Array(NODE_COUNT) : null;

        for (const edge of edges) {
            const vis = edgeVisibility(edge, now);
            if (vis <= 0) {
                continue;
            }

            const aIdx = edge.a;
            const bIdx = edge.b;
            const a = nodes[aIdx];
            const b = nodes[bIdx];

            const isHoverLink = hoveredNode >= 0 && (aIdx === hoveredNode || bIdx === hoveredNode);
            const isContagionLink = displayInfection[aIdx] > 0.2 && displayInfection[bIdx] > 0.2;

            if (hoverNeighborWeight && isHoverLink && vis > 0.15) {
                const other = aIdx === hoveredNode ? bIdx : aIdx;
                hoverNeighborWeight[other] = Math.max(hoverNeighborWeight[other], vis);
            }

            let alpha = Math.max(0.08, vis * 0.48);
            let lineWidth = 1.05;
            let edgeGray = 40;

            if (isContagionLink) {
                alpha *= 1.12;
                lineWidth = 1.12;
                edgeGray = 32;
            }

            if (isHoverLink) {
                alpha *= 1.7;
                lineWidth = 1.48;
                edgeGray = 24;
            }

            alpha = Math.min(0.78, alpha);
            ctx.strokeStyle = `rgba(${edgeGray}, ${edgeGray}, ${edgeGray}, ${alpha.toFixed(3)})`;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        for (let i = 0; i < NODE_COUNT; i += 1) {
            const node = nodes[i];
            const infectedStrength = Math.max(0, Math.min(1, displayInfection[i]));
            const isHovered = i === hoveredNode;
            const neighborWeight = hoverNeighborWeight ? hoverNeighborWeight[i] : 0;

            const groupColor = node.group === 0 ? GRAY_10 : GRAY_90;
            const alphaDrift = 0.72 + 0.18 * (0.5 + 0.5 * Math.sin(now * 0.00045 + node.alphaPhase));
            const fillAlpha = 0.5 + alphaDrift * 0.5;

            if (neighborWeight > 0.01 && infectedStrength < 0.02 && !isHovered) {
                const cueRadius = node.radius + 1.8 + neighborWeight * 1.35;
                const cueAlpha = Math.min(0.3, 0.1 + neighborWeight * 0.24);
                const cue = ctx.createRadialGradient(
                    node.x,
                    node.y,
                    Math.max(0.2, node.radius * 0.5),
                    node.x,
                    node.y,
                    cueRadius
                );
                cue.addColorStop(0, `rgba(${GLOW_CORE_RGB.r}, ${GLOW_CORE_RGB.g}, ${GLOW_CORE_RGB.b}, ${cueAlpha.toFixed(3)})`);
                cue.addColorStop(0.58, `rgba(${GLOW_OUTER_RGB.r}, ${GLOW_OUTER_RGB.g}, ${GLOW_OUTER_RGB.b}, ${Math.min(0.34, cueAlpha * 1.08).toFixed(3)})`);
                cue.addColorStop(1, `rgba(${GLOW_OUTER_RGB.r}, ${GLOW_OUTER_RGB.g}, ${GLOW_OUTER_RGB.b}, 0)`);
                ctx.fillStyle = cue;
                ctx.beginPath();
                ctx.arc(node.x, node.y, cueRadius, 0, Math.PI * 2);
                ctx.fill();
            }

            if (infectedStrength > 0.02 || isHovered) {
                const glowCore = 0.42 + infectedStrength * 0.58 + (isHovered ? 0.22 : 0);
                const glowMid = 0.26 + infectedStrength * 0.4 + (isHovered ? 0.14 : 0);
                const glowRadius = node.radius + 3.2 + infectedStrength * 2.45 + (isHovered ? 1.05 : 0);
                const gradient = ctx.createRadialGradient(
                    node.x,
                    node.y,
                    Math.max(0.2, node.radius * 0.45),
                    node.x,
                    node.y,
                    glowRadius
                );
                gradient.addColorStop(0, `rgba(${GLOW_CORE_RGB.r}, ${GLOW_CORE_RGB.g}, ${GLOW_CORE_RGB.b}, ${Math.min(0.95, glowCore).toFixed(3)})`);
                gradient.addColorStop(0.38, `rgba(${GLOW_CORE_RGB.r}, ${GLOW_CORE_RGB.g}, ${GLOW_CORE_RGB.b}, ${Math.min(0.88, glowCore * 0.95).toFixed(3)})`);
                gradient.addColorStop(0.72, `rgba(${GLOW_OUTER_RGB.r}, ${GLOW_OUTER_RGB.g}, ${GLOW_OUTER_RGB.b}, ${Math.min(0.62, glowMid).toFixed(3)})`);
                gradient.addColorStop(1, `rgba(${GLOW_OUTER_RGB.r}, ${GLOW_OUTER_RGB.g}, ${GLOW_OUTER_RGB.b}, 0)`);
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.fillStyle = `rgba(${groupColor}, ${groupColor}, ${groupColor}, ${Math.min(1, fillAlpha).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius + (isHovered ? 0.45 : 0), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function rewireEdges(now) {
        for (let i = 0; i < edges.length; i += 1) {
            const edge = edges[i];
            if (now >= edge.rewireAt) {
                resetEdge(edge, now, i);
            }
        }
    }

    function animationFrame(now) {
        const dt = Math.min(40, now - lastFrame);
        lastFrame = now;

        updateNodeMotion(dt, now);
        rewireEdges(now);
        updateHoverState(now);
        stepContagion(now);
        applyResetTargets(now);
        animateInfection(dt);
        draw(now);

        requestAnimationFrame(animationFrame);
    }

    function mapPointerEvent(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = event.clientX - rect.left;
        pointer.y = event.clientY - rect.top;
    }

    function handlePointerMove(event) {
        pointer.inside = true;
        mapPointerEvent(event);
    }

    function handlePointerLeave() {
        pointer.inside = false;
        attractLockIndex = -1;
        attractLockUntil = 0;
        hoveredNode = -1;
        hoveredSince = 0;
        hoverContagionStarted = false;
        contagionState = null;
        beginReset(performance.now());
    }

    function handlePointerDown(event) {
        pointer.inside = true;
        mapPointerEvent(event);

        const now = performance.now();
        const clickedNode = findHoveredNode();
        if (clickedNode < 0) {
            return;
        }

        if (clickedNode !== hoveredNode && (hoveredNode >= 0 || contagionState !== null)) {
            beginReset(now);
        }

        hoveredNode = clickedNode;
        hoveredSince = now;
        resetState = null;
        contagionState = null;
        buildHoverTargets(clickedNode);

        // Tap/click should initiate contagion immediately on the selected node.
        hoverContagionStarted = true;
        startContagion(now);
    }

    function resizeCanvas() {
        const rect = parent.getBoundingClientRect();
        const prevWidth = width || rect.width;
        const prevHeight = height || rect.height;

        width = rect.width;
        height = rect.height;
        dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (nodes.length > 0 && prevWidth > 0 && prevHeight > 0) {
            const sx = width / prevWidth;
            const sy = height / prevHeight;
            for (const node of nodes) {
                node.x *= sx;
                node.y *= sy;
            }
        }
    }

    function init() {
        resizeCanvas();
        createNodes();
        seedBaseInfection();
        buildEdges(performance.now());

        canvas.addEventListener("pointermove", handlePointerMove);
        canvas.addEventListener("pointerdown", handlePointerDown);
        canvas.addEventListener("pointerleave", handlePointerLeave);
        canvas.addEventListener("pointercancel", handlePointerLeave);
        window.addEventListener("resize", resizeCanvas);

        requestAnimationFrame((t) => {
            lastFrame = t;
            requestAnimationFrame(animationFrame);
        });
    }

    init();
})();
