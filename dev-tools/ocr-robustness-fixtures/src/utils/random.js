function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.round(randRange(min, max));
}

function chance(probability) {
  return Math.random() < probability;
}

function pick(range) {
  return randRange(range[0], range[1]);
}

module.exports = { randRange, randInt, chance, pick };
