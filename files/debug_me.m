% debug_me.m  -  smooth a raw ECG and plot it
x = load('signal.mat');
fs = 360;
b = ones(1, 8) / 8;          % 8-point moving average
a = 1;
y = filter(b, a, x]
t = (0:length(y)) / fs;
plot(t, y);
xlabel('Time (s)'); ylabel('Amplitude (mV)');
title('Smoothed ECG');
fprintf('Samples      : %d\n', length(y));
fprintf('Duration (s) : %.4f\n', t(end));
fprintf('Mean (mV)    : %.4f\n', mean(y));
