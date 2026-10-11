// Offline quiz questions for common science topics, used when Gemini isn't reachable.
// (CS questions with code live in csbank.js.)
export const BANK={
  'Kinetics':[
    {q:'For a first-order reaction, what happens to the half-life as the reactant gets used up?',o:['It stays the same','It gets longer','It gets shorter','It drops to zero'],a:0,x:'First-order half-life is ln 2 / k, which doesn\'t depend on concentration.'},
    {q:'Doubling [A] makes the rate four times faster. What order is the reaction in A?',o:['Zero order','First order','Second order','Fourth order'],a:2,x:'The rate goes up by 2² = 4, so it\'s second order in A.'},
    {q:'How does a catalyst speed up a reaction?',o:['It raises the temperature','It lowers the activation energy','It increases ΔH','It shifts the equilibrium'],a:1,x:'A catalyst offers a lower-energy pathway without being used up.'}],
  'Equilibrium':[
    {q:'If Q is less than K, which way does the reaction shift?',o:['Toward products','Toward reactants','It doesn\'t shift','It depends on the catalyst'],a:0,x:'Q < K means there aren\'t enough products yet, so it moves forward.'},
    {q:'What does adding a catalyst do to a system already at equilibrium?',o:['Increases K','Shifts it toward products','Nothing to K or the equilibrium position','Shifts it toward reactants'],a:2,x:'Catalysts speed up both directions equally, so equilibrium doesn\'t change.'},
    {q:'For an exothermic reaction, what happens to K when you raise the temperature?',o:['K increases','K decreases','K stays the same','K becomes zero'],a:1,x:'Heat acts like a product in an exothermic reaction, so adding it shifts left and lowers K.'}],
  'Acids & bases':[
    {q:'What is the pH of 0.010 M HCl?',o:['1','2','10','12'],a:1,x:'HCl fully dissociates, so [H⁺] = 10⁻² M and the pH is 2.'},
    {q:'Which pair makes a good buffer?',o:['A strong acid and a strong base','A weak acid and its conjugate base','A strong acid and its conjugate base','Pure water and table salt'],a:1,x:'A weak acid with its conjugate base can absorb added acid or base.'},
    {q:'At 25°C a solution has a pH of 4. What is its pOH?',o:['4','7','10','14'],a:2,x:'pH + pOH = 14 at 25°C, so pOH = 10.'}],
  'Limits':[
    {q:'What is the limit of sin(x)/x as x approaches 0?',o:['0','1','∞','It doesn\'t exist'],a:1,x:'This is a standard limit: sin(x)/x → 1 as x → 0.'},
    {q:'What is the limit of (x² − 4)/(x − 2) as x approaches 2?',o:['0','2','4','It doesn\'t exist'],a:2,x:'Factor to (x − 2)(x + 2)/(x − 2) = x + 2, which goes to 4.'},
    {q:'What is the limit of 1/x as x approaches ∞?',o:['0','1','∞','−1'],a:0,x:'As x grows without bound, 1/x shrinks toward 0.'}],
  'Derivatives':[
    {q:'What is the derivative of x³?',o:['x²','3x²','3x','x⁴/4'],a:1,x:'Power rule: bring down the 3 and subtract one from the exponent.'},
    {q:'What is the derivative of sin(x)?',o:['cos(x)','−cos(x)','−sin(x)','tan(x)'],a:0,x:'d/dx sin(x) = cos(x).'},
    {q:'What is the derivative of e^(2x)?',o:['e^(2x)','2e^(2x)','2x·e^(2x)','e^(2x)/2'],a:1,x:'Chain rule: the derivative of the inside, 2, multiplies e^(2x).'}],
  'Related rates':[
    {q:'A circle\'s radius grows at 2 cm/s. How fast is the area growing when r = 3 cm?',o:['6π cm²/s','9π cm²/s','12π cm²/s','18π cm²/s'],a:2,x:'dA/dt = 2πr · dr/dt = 2π(3)(2) = 12π.'},
    {q:'A 10 ft ladder\'s base slides away at 1 ft/s. How fast does the top slide down when the base is 6 ft out?',o:['0.5 ft/s','0.75 ft/s','1 ft/s','1.33 ft/s'],a:1,x:'x² + y² = 100 gives y = 8, so dy/dt = −(6 · 1) / 8 = −0.75.'},
    {q:'For a sphere, V = (4/3)πr³. What is dV/dt?',o:['4πr² · dr/dt','(4/3)πr² · dr/dt','4πr · dr/dt','πr³ · dr/dt'],a:0,x:'By the chain rule, dV/dt = 4πr² · dr/dt.'}]
};
